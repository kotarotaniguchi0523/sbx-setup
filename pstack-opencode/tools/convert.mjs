#!/usr/bin/env node
// Convert cursor/plugins/pstack into an OpenCode-ready APM package.
//
// Pipeline:
//   1. repomix --remote cursor/plugins --include "pstack/**" --style json
//   2. split the packed JSON back into per-skill / per-agent files
//   3. normalise frontmatter for OpenCode and inject the OpenCode mapping
//   4. write the .apm/ tree that `apm install` consumes
//
// Run:  node tools/convert.mjs
//
// Re-run whenever cursor/plugins/pstack changes; it regenerates .apm/ from
// scratch.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TPL = join(ROOT, "tools", "templates");
const REPO = "cursor/plugins";
const INCLUDE = "pstack/**";

// Which OpenCode subagent tools each pstack agent may use. Anything not listed
// keeps OpenCode's default (enabled).
const AGENT_OVERRIDES = {
  "poteto-agent": {},
  "comment-sicko": { edit: false, write: false, patch: false, subagent: false },
};

// Skills that get exposed as a slash command in OpenCode.
const SLASH = new Set(["poteto-mode"]);

// Heuristic: does this skill body reference Cursor / Claude-only primitives?
const NEEDS_NOTE =
  /subagent_type|Task tool|AskUserQuestion|\bopus\b|\bgrok\b|\bfable\b|\/loop\b|CLAUDE_PLUGIN_ROOT/;

// fs.rmSync crashes Node on Windows when the path contains non-ASCII
// characters (STATUS_STACK_BUFFER_OVERRUN), so remove trees through the shell.
function cleanDir(dir) {
  if (!existsSync(dir)) return;
  const cmd = process.platform === "win32"
    ? `cmd /c rmdir /s /q "${dir}"`
    : `rm -rf "${dir}"`;
  try {
    execSync(cmd, { stdio: "ignore", shell: true });
  } catch {
    /* already gone */
  }
}

function repomix() {
  if (process.env.PSTACK_PACKED) {
    process.stderr.write(`reading packed repo from ${process.env.PSTACK_PACKED}\n`);
    return JSON.parse(readFileSync(process.env.PSTACK_PACKED, "utf8"));
  }
  const cache = join(ROOT, ".cache", "pstack-pack.json");
  mkdirSync(dirname(cache), { recursive: true });
  process.stderr.write(`packing ${REPO} (${INCLUDE}) with repomix...\n`);
  // Write to a file rather than capturing stdout: a multi-hundred-KB pipe
  // capture crashes Node on Windows.
  const cmd = `npx -y repomix@latest --remote ${REPO} --include "${INCLUDE}" --style json -o "${cache}"`;
  try {
    execSync(cmd, { stdio: ["ignore", "inherit", "inherit"], shell: true });
  } catch (err) {
    process.stderr.write(`repomix failed (status ${err.status})\n`);
    throw err;
  }
  return JSON.parse(readFileSync(cache, "utf8"));
}

// Resolve the upstream main commit so SOURCE.json only changes when 本家 moves.
function upstreamRef() {
  try {
    const out = execSync(`git ls-remote https://github.com/${REPO} refs/heads/main`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });
    return out.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

// --- minimal YAML frontmatter handling -------------------------------------

function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  return { data: parseSimpleYaml(m[1]), body: text.slice(m[0].length) };
}

function parseSimpleYaml(src) {
  const data = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z0-9_./-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      value = block.join(" ");
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    data[key] = value;
  }
  return data;
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function renderFrontmatter(pairs, metadata) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(pairs)) lines.push(`${k}: ${yamlScalar(v)}`);
  const md = Object.entries(metadata).filter(([, v]) => v !== undefined);
  if (md.length) {
    lines.push("metadata:");
    for (const [k, v] of md) lines.push(`  ${k}: ${yamlScalar(v)}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

const NOTE =
  "> **OpenCode note.** This skill was authored for Cursor / Claude Code. " +
  "Where it names a tool, a subagent, or a model, use the OpenCode equivalent " +
  "in the `poteto-mode` skill's `references/opencode-tools.md`.\n\n";

// Deterministic body rewrites for Cursor / Claude Code references that have an
// unambiguous OpenCode equivalent. Ambiguous prose (model slugs like `opus`,
// `/loop`, plugin-driver names) is left to references/opencode-tools.md.
const BODY_REPLACEMENTS = [
  // paths
  [/~\/\.claude\/skills/g, "~/.config/opencode/skills"],
  [/\.claude\/skills/g, ".opencode/skills"],
  [/~\/\.claude/g, "~/.config/opencode"],
  [/\bCLAUDE\.md\b/g, "AGENTS.md"],
  // Claude tool names
  [/`Skill` tool/g, "`skill` tool"],
  [/the Skill tool/g, "the `skill` tool"],
  [/`Agent` tool/g, "`subagent` tool"],
  [/the Agent tool/g, "the `subagent` tool"],
  [/`Task` tool/g, "`subagent` tool"],
  [/Task tool/g, "subagent tool"],
  [/AskUserQuestion/g, "the `question` tool"],
  [/\bTodoWrite\b/g, "the `todo.md` checklist"],
  [/\bTaskCreate\b/g, "the `todo.md` checklist"],
  [/\bTaskUpdate\b/g, "the `todo.md` checklist"],
  // Cursor command with no OpenCode equivalent
  [/\/loop\b/g, "a repeating loop"],
];

let bodyReplacements = 0;

function translateBody(body) {
  for (const [re, to] of BODY_REPLACEMENTS) {
    body = body.replace(re, () => {
      bodyReplacements++;
      return to;
    });
  }
  return body;
}

// --- conversions ------------------------------------------------------------

function convertSkill(id, raw) {
  const { data, body } = splitFrontmatter(raw);
  const metadata = {};
  if (data.name && data.name !== id) metadata["pstack/original-name"] = data.name;
  if (SLASH.has(id)) metadata["opencode/slash"] = "true";
  if (String(data["disable-model-invocation"]).toLowerCase() === "true" && !SLASH.has(id)) {
    metadata["opencode/autoinvoke"] = "false";
  }
  const fm = renderFrontmatter(
    { name: id, description: data.description ?? `${id} (pstack skill)` },
    metadata,
  );
  const note = NEEDS_NOTE.test(body) ? NOTE : "";
  return fm + "\n" + note + translateBody(body).replace(/^\n+/, "");
}

function convertAgent(id, raw) {
  const { data, body } = splitFrontmatter(raw);
  const overrides = AGENT_OVERRIDES[id] ?? {};
  const tools = {};
  for (const [tool, enabled] of Object.entries(overrides)) tools[tool] = enabled;
  const lines = ["---"];
  lines.push(`description: ${yamlScalar(data.description ?? `${id} (pstack agent)`)}`);
  lines.push("mode: subagent");
  lines.push(`color: ${yamlScalar(id === "comment-sicko" ? "info" : "primary")}`);
  if (Object.keys(tools).length) {
    lines.push("tools:");
    for (const [t, v] of Object.entries(tools)) lines.push(`  ${t}: ${v}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n\n" + translateBody(body).replace(/^\n+/, "");
}

// --- main -------------------------------------------------------------------

function main() {
  const packed = repomix();
  const files = packed.files ?? {};
  const apm = join(ROOT, ".apm");
  process.stderr.write(`parsed ${Object.keys(files).length} files\n`);
  cleanDir(apm);
  process.stderr.write("cleaned .apm\n");

  const skills = new Set();
  const agents = new Set();
  let written = 0;

  for (const [path, content] of Object.entries(files)) {
    const skill = path.match(/^pstack\/skills\/([^/]+)\/(.+)$/);
    const agent = path.match(/^pstack\/agents\/([^/]+)\.md$/);

    if (skill) {
      const [, id, rel] = skill;
      skills.add(id);
      const dest = join(apm, "skills", id, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const body =
        rel === "SKILL.md" ? convertSkill(id, content)
        : rel.endsWith(".md") ? translateBody(content)
        : content; // scripts and other assets are copied verbatim
      writeFileSync(dest, body, "utf8");
      written++;
    } else if (agent) {
      const [, id] = agent;
      agents.add(id);
      const dest = join(apm, "agents", `${id}.agent.md`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, convertAgent(id, content), "utf8");
      written++;
    }
  }

  // Inject the OpenCode mapping beside poteto-mode.
  const mapDest = join(apm, "skills", "poteto-mode", "references", "opencode-tools.md");
  mkdirSync(dirname(mapDest), { recursive: true });
  copyFileSync(join(TPL, "opencode-tools.md"), mapDest);

  // Routing instruction. Shipped as a plain AGENTS.md rather than an APM
  // instruction: `apm compile -g` emits an instruction body twice, and a
  // verbatim file keeps the global AGENTS.md exact.
  const routingDest = join(ROOT, "opencode", "AGENTS.md");
  mkdirSync(dirname(routingDest), { recursive: true });
  copyFileSync(join(TPL, "AGENTS.md"), routingDest);

  writeFileSync(
    join(ROOT, "SOURCE.json"),
    JSON.stringify(
      { repository: REPO, include: INCLUDE, ref: upstreamRef(), skills: [...skills].sort(), agents: [...agents].sort() },
      null,
      2,
    ) + "\n",
  );

  process.stderr.write(`done: ${skills.size} skills, ${agents.size} agents, ${written} files, ${bodyReplacements} body rewrites\n`);
}

main();
