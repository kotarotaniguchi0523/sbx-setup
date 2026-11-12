#!/usr/bin/env node
// Convert cursor/plugins/pstack into an OpenCode-ready APM package.
//
// Pipeline:
//   1. sparse, shallow git fetch of cursor/plugins at the pinned commit
//      (only pstack/ and the EXTRA_SKILLS directories are checked out;
//      files arrive byte-for-byte)
//   2. walk pstack/skills, pstack/agents and the extra skills
//   3. normalise frontmatter for OpenCode and inject the OpenCode mapping
//   4. write the .apm/ tree that `apm install` consumes
//
// Repomix was used for step 1 until it started dropping files (lock files,
// .dot fixtures) and trimming trailing newlines, which made every regeneration
// diverge from upstream. Plain git keeps the copy exact.
//
// Run:  node tools/convert.mjs
//
// Re-run whenever cursor/plugins/pstack changes; it regenerates .apm/ from
// scratch.

import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TPL = join(ROOT, "tools", "templates");
const REPO = "cursor/plugins";
const SUBDIR = "pstack";

// Skills from other cursor/plugins plugins that pstack's own text tells the
// agent to use (poteto-mode: "the `deslop` skill from the `cursor-team-kit`
// plugin", "`control-cli` / `control-ui` from `cursor-team-kit`"). They ship
// alongside pstack, pinned to the same upstream commit, so those instructions
// resolve inside OpenCode. Only the referenced skills come along, not the
// whole plugin.
const EXTRA_SKILLS = {
  "cursor-team-kit": ["deslop", "control-cli", "control-ui"],
};
const EXTRA_DIRS = Object.entries(EXTRA_SKILLS).flatMap(([plugin, ids]) =>
  ids.map((id) => `${plugin}/skills/${id}`),
);
// Every upstream directory the package is built from. SOURCE.json records a
// git tree id for each, and pstack-update compares those ids to decide
// whether anything this package ships changed.
const TRACKED = [SUBDIR, ...EXTRA_DIRS];
const INCLUDE = TRACKED.map((d) => `${d}/**`);

// Which OpenCode subagent tools each pstack agent may use. Anything not listed
// keeps OpenCode's default (enabled).
const AGENT_OVERRIDES = {
  "poteto-agent": {},
  "comment-sicko": { edit: false, write: false, patch: false, subagent: false },
};

// Skills that get exposed as a slash command in OpenCode.
const SLASH = new Set(["poteto-mode"]);

// Every skill published by upstream pstack is shipped. An allowlist used to
// drop the skills not reachable from poteto-mode, but it went stale: upstream
// adds skills (principles, ketchup, ...) and poteto-mode's own text starts
// referencing them, so the shipped set broke. Mirroring upstream wholesale
// keeps the package a faithful sync and makes new skills arrive automatically.

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

// Fetch only the TRACKED directories at `ref` and return
// { files: { "<dir>/...": Buffer }, trees: { "<dir>": treeId } }.
// The tree ids let callers tell whether those directories themselves changed
// (the upstream repo hosts other plugins too).
function fetchUpstream(ref) {
  const dir = join(ROOT, ".cache", "upstream");
  cleanDir(dir);
  mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stderr.write(`fetching ${REPO}@${ref} (${TRACKED.join(", ")}) with git...\n`);
  git("init", "-q");
  // Byte-exact checkout on every host (no CRLF conversion on Windows).
  git("config", "core.autocrlf", "false");
  git("config", "core.eol", "lf");
  git("sparse-checkout", "set", "--no-cone", ...TRACKED.map((d) => `/${d}/`));
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", `https://github.com/${REPO}.git`, ref);
  git("checkout", "-q", "FETCH_HEAD");
  const trees = {};
  const files = {};
  for (const d of TRACKED) {
    // rev-parse fails loudly if upstream moved or removed a tracked directory.
    trees[d] = git("rev-parse", `FETCH_HEAD:${d}`).trim();
    for (const entry of readdirSync(join(dir, d), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const abs = join(entry.parentPath ?? entry.path, entry.name);
      const rel = abs.slice(dir.length + 1).split(/[\\/]/).join("/");
      files[rel] = readFileSync(abs);
    }
  }
  return { files, trees };
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

function convertSkill(id, raw, plugin) {
  const { data, body } = splitFrontmatter(raw);
  const metadata = {};
  if (plugin !== SUBDIR) metadata["pstack/source-plugin"] = plugin;
  if (data.name && data.name !== id) metadata["pstack/original-name"] = data.name;
  if (SLASH.has(id)) metadata["opencode/slash"] = "true";
  if (String(data["disable-model-invocation"]).toLowerCase() === "true" && !SLASH.has(id)) {
    metadata["opencode/autoinvoke"] = "false";
  }
  const fm = renderFrontmatter(
    { name: id, description: data.description ?? `${id} (${plugin} skill)` },
    metadata,
  );
  const note = NEEDS_NOTE.test(body) ? NOTE : "";
  return fm + "\n" + note + translateBody(body).replace(/^(\r?\n)+/, "");
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
  return lines.join("\n") + "\n\n" + translateBody(body).replace(/^(\r?\n)+/, "");
}

// --- main -------------------------------------------------------------------

function main() {
  const ref = upstreamRef();
  const { files, trees } = fetchUpstream(ref);
  const apm = join(ROOT, ".apm");
  process.stderr.write(`parsed ${Object.keys(files).length} files\n`);

  // Every upstream skill ships. Keep the count in the log so a sync that
  // unexpectedly loses skills is visible in the build output.
  const upstreamSkills = new Set();
  for (const path of Object.keys(files)) {
    const m = path.match(/^pstack\/skills\/([^/]+)\//);
    if (m) upstreamSkills.add(m[1]);
  }
  process.stderr.write(`skills: shipping all ${upstreamSkills.size} from pstack + ${EXTRA_DIRS.length} extra\n`);
  // An extra skill must not shadow a pstack skill of the same name.
  for (const [plugin, ids] of Object.entries(EXTRA_SKILLS)) {
    for (const id of ids) {
      if (upstreamSkills.has(id)) throw new Error(`extra skill ${plugin}/${id} collides with pstack/skills/${id}`);
    }
  }

  cleanDir(apm);
  process.stderr.write("cleaned .apm\n");

  const skills = new Set();
  const agents = new Set();
  let written = 0;

  for (const [path, content] of Object.entries(files)) {
    const skill = path.match(/^([^/]+)\/skills\/([^/]+)\/(.+)$/);
    const agent = path.match(/^pstack\/agents\/([^/]+)\.md$/);

    if (skill) {
      const [, plugin, id, rel] = skill;
      skills.add(id);
      const dest = join(apm, "skills", id, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const body =
        rel === "SKILL.md" ? convertSkill(id, content.toString("utf8"), plugin)
        : rel.endsWith(".md") ? translateBody(content.toString("utf8"))
        : content; // scripts, lock files and other assets are copied byte-for-byte
      writeFileSync(dest, body);
      written++;
    } else if (agent) {
      const [, id] = agent;
      agents.add(id);
      const dest = join(apm, "agents", `${id}.agent.md`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, convertAgent(id, content.toString("utf8")), "utf8");
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
      { repository: REPO, include: INCLUDE, ref, trees, skills: [...skills].sort(), agents: [...agents].sort() },
      null,
      2,
    ) + "\n",
  );

  process.stderr.write(`done: ${skills.size} skills, ${agents.size} agents, ${written} files, ${bodyReplacements} body rewrites\n`);
}

main();
