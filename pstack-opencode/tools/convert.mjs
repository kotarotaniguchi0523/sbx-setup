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

// Only these upstream skills are shipped. The list is the set reachable from
// poteto-mode through its own files (SKILL.md, playbooks/, references/,
// scripts/), plus poteto-help, pstack's index skill (its catalog is trimmed to
// this set below). Every other skill in the upstream plugin is dropped.
const INCLUDE_SKILLS = new Set([
  "architect",
  "arena",
  "benchmark-checklist",
  "create-verification-skill",
  "figure-it-out",
  "how",
  "interrogate",
  "maintain-verification-skill",
  "no-comments",
  "poteto-mode",
  "principle-boundary-discipline",
  "principle-build-the-lever",
  "principle-encode-lessons-in-structure",
  "principle-exhaust-the-design-space",
  "principle-fix-root-causes",
  "principle-foundational-thinking",
  "principle-guard-the-context-window",
  "principle-laziness-protocol",
  "principle-make-operations-idempotent",
  "principle-migrate-callers-then-delete-legacy-apis",
  "principle-minimize-reader-load",
  "principle-model-the-domain",
  "principle-never-block-on-the-human",
  "principle-outcome-oriented-execution",
  "principle-prove-it-works",
  "principle-redesign-from-first-principles",
  "principle-separate-before-serializing-shared-state",
  "principle-sequence-verifiable-units",
  "principle-subtract-before-you-add",
  "reflect",
  "setup-pstack",
  "show-me-your-work",
  "swarm",
  "tdd",
  "technical-writing",
  "unslop",
  "why",
  // pstack's index skill; kept but its catalog is trimmed to this set.
  "poteto-help",
]);

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

function repomix(ref) {
  if (process.env.PSTACK_PACKED) {
    process.stderr.write(`reading packed repo from ${process.env.PSTACK_PACKED}\n`);
    return JSON.parse(readFileSync(process.env.PSTACK_PACKED, "utf8"));
  }
  const cache = join(ROOT, ".cache", "pstack-pack.json");
  mkdirSync(dirname(cache), { recursive: true });
  process.stderr.write(`packing ${REPO} (${INCLUDE}) with repomix...\n`);
  // Write to a file rather than capturing stdout: a multi-hundred-KB pipe
  // capture crashes Node on Windows.
  const cmd = `npx -y repomix@1.18.1 --remote ${REPO} --remote-branch "${ref}" --include "${INCLUDE}" --style json -o "${cache}"`;
  try {
    execSync(cmd, { stdio: ["ignore", "inherit", "inherit"], shell: true });
  } catch (err) {
    process.stderr.write(`repomix failed (status ${err.status})\n`);
    throw err;
  }
  return JSON.parse(readFileSync(cache, "utf8"));
}

// An explicit refresh uses the new upstream main commit; regular conversions
// (including Docker builds) reproduce the reviewed SOURCE.json snapshot.
function upstreamRef() {
  if (process.env.PSTACK_REF) {
    if (!/^[a-f0-9]{40}$/i.test(process.env.PSTACK_REF)) throw new Error("invalid PSTACK_REF");
    return process.env.PSTACK_REF;
  }
  if (process.env.PSTACK_REFRESH === "1") {
    const out = execSync(`git ls-remote https://github.com/${REPO} refs/heads/main`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
    });
    const sha = out.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/i.test(sha || "")) throw new Error("unable to resolve upstream main commit");
    return sha;
  }
  const recorded = JSON.parse(readFileSync(join(ROOT, "SOURCE.json"), "utf8")).ref;
  if (!/^[a-f0-9]{40}$/i.test(recorded || "")) throw new Error("SOURCE.json.ref is invalid");
  return recorded;
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

// poteto-help is pstack's index skill: a catalog of every skill. With a
// trimmed skill set, drop any line that names a dropped skill as a slash
// command (`/name`) or a relative link (`../name/`), so the catalog does not
// point at skills we no longer ship.
function trimHelp(body, dropped) {
  if (!dropped.length) return body;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alt = dropped.map(esc).join("|");
  const deadLine = new RegExp(`(?:^|[^\\w-])/(?:${alt})(?![\\w-])|\\.\\./(?:${alt})/`);
  return body
    .split(/\r?\n/)
    .filter((line) => !deadLine.test(line))
    .join("\n");
}

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
  const ref = upstreamRef();
  const packed = repomix(ref);
  const files = packed.files ?? {};
  const apm = join(ROOT, ".apm");
  process.stderr.write(`parsed ${Object.keys(files).length} files\n`);

  // Which upstream skills exist, and which we drop. Computed up front so
  // poteto-help's catalog can be trimmed as it is written.
  const upstreamSkills = new Set();
  for (const path of Object.keys(files)) {
    const m = path.match(/^pstack\/skills\/([^/]+)\//);
    if (m) upstreamSkills.add(m[1]);
  }
  const dropped = [...upstreamSkills].filter((s) => !INCLUDE_SKILLS.has(s)).sort();
  const missing = [...INCLUDE_SKILLS].filter((s) => !upstreamSkills.has(s)).sort();
  if (missing.length) process.stderr.write(`warning: INCLUDE_SKILLS not found upstream: ${missing.join(", ")}\n`);
  process.stderr.write(`skills: keeping ${upstreamSkills.size - dropped.length}/${upstreamSkills.size} (dropped ${dropped.length})\n`);

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
      if (!INCLUDE_SKILLS.has(id)) continue;
      skills.add(id);
      const dest = join(apm, "skills", id, rel);
      mkdirSync(dirname(dest), { recursive: true });
      let body =
        rel === "SKILL.md" ? convertSkill(id, content)
        : rel.endsWith(".md") ? translateBody(content)
        : content; // scripts and other assets are copied verbatim
      if (id === "poteto-help" && rel.endsWith(".md")) body = trimHelp(body, dropped);
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
      { repository: REPO, include: INCLUDE, ref, skills: [...skills].sort(), agents: [...agents].sort() },
      null,
      2,
    ) + "\n",
  );

  process.stderr.write(`done: ${skills.size} skills, ${agents.size} agents, ${written} files, ${bodyReplacements} body rewrites\n`);
}

main();
