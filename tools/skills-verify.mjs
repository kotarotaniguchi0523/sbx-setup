#!/usr/bin/env node
// Verify a skill-update branch and post the result to its pull request.
//
// The delta is simply the Git diff against the base branch (each update run
// creates a branch), so we only scan what actually changed.
//
//   node tools/skills-verify.mjs [--base main]   run checks, write report + gate
//   node tools/skills-verify.mjs --post <PR>      upsert the report as a PR comment
//   node tools/skills-verify.mjs --gate           exit 1 if the gate failed
//
// Requires on PATH: apm, skillspector, git, gh (gh only for --post).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "pstack-opencode";
const PROJECT_DIR = join(ROOT, PROJECT);
const BASELINE = join(ROOT, "tools", "skillspector-baseline.yaml");
const SKILLS_DIR = join(PROJECT_DIR, ".agents", "skills");
const SARIF_DIR = join(ROOT, ".cache", "skills-verify");
const REPORT = join(SARIF_DIR, "report.md");
const GATE_FILE = join(SARIF_DIR, "gate.json");
const MARKER = "<!-- skills-verify -->";
const GATE_RULES = new Set([
  "YR1", "YR2", "YR3", "YR4", "TT3", "TT5", "AST8",
  "P1", "P2", "P3", "AR1", "AR2", "AR3", "E2", "E4", "PE3", "SC3",
  "SSD-1", "SSD-2", "SSD-3", "SSD-4",
]);

const flag = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
};
const log = (m) => process.stderr.write(`[skills-verify] ${m}\n`);
const run = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// Restore OpenCode's own credentials (no API key needed) from the
// OPENCODE_AUTH_JSON secret, so opencode_cli can run its LLM triage.
function restoreOpenCodeAuth() {
  const json = process.env.OPENCODE_AUTH_JSON;
  if (!json) return;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) return;
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), json);
  log("restored OpenCode credentials from OPENCODE_AUTH_JSON");
}

// LLM triage is available when OpenCode credentials or an explicit model exist.
const llmEnabled = () =>
  Boolean(process.env.OPENCODE_AUTH_JSON || process.env.SKILLSPECTOR_MODEL);

// --- delta: only what this branch changed vs the base -----------------------
function changedTargets(base) {
  const changed = run("git", ["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const skills = new Set();
  let lockChanged = false;
  for (const path of changed) {
    if (path.startsWith(`${PROJECT}/.apm/skills/`)) {
      const name = path.slice(`${PROJECT}/.apm/skills/`.length).split("/")[0];
      if (name) skills.add(name);
    }
    if (path === `${PROJECT}/apm.lock.yaml`) lockChanged = true;
  }
  return { skills: [...skills], lockChanged };
}

function targetDirs(delta) {
  const dirs = [];
  for (const name of delta.skills) {
    const dir = join(SKILLS_DIR, name);
    if (existsSync(dir)) dirs.push(dir);
  }
  // A lockfile change refreshes the external skills; scan them all (small set).
  if (delta.lockChanged && existsSync(SKILLS_DIR)) dirs.push(SKILLS_DIR);
  return [...new Set(dirs)];
}

// --- run --------------------------------------------------------------------
function verify() {
  const base = flag("base", "main");
  mkdirSync(SARIF_DIR, { recursive: true });
  restoreOpenCodeAuth();

  const delta = changedTargets(base);
  log(`changed pstack skills: ${delta.skills.join(", ") || "(none)"}; lock changed: ${delta.lockChanged}`);

  if (delta.skills.length === 0 && !delta.lockChanged) {
    writeFileSync(REPORT, "# Skill verification\n\nNo skill changes on this branch.\n");
    writeFileSync(GATE_FILE, JSON.stringify({ highSignal: 0, changed: 0, lockChanged: false }));
    return;
  }

  // Materialise the lock-pinned skills, then verify integrity with APM.
  log("apm install --frozen");
  run("apm", ["install", "--frozen"], PROJECT_DIR);
  const apmSarif = join(SARIF_DIR, "apm-audit.sarif");
  log("apm audit --ci");
  run("apm", ["audit", "--ci", "--format", "sarif", "--output", apmSarif], PROJECT_DIR);

  const sarifs = [];
  for (const target of targetDirs(delta)) {
    const name = target === SKILLS_DIR ? "external" : target.split(/[\\/]/).pop();
    const out = join(SARIF_DIR, `skillspector-${name}.sarif`);
    log(`skillspector scan ${target}`);
    const args = ["scan", target, "--baseline", BASELINE, "--format", "sarif", "--output", out];
    const env = { ...process.env };
    if (llmEnabled()) env.SKILLSPECTOR_PROVIDER = "opencode_cli";
    else args.push("--no-llm");
    try {
      execFileSync("skillspector", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], env });
    } catch {
      // Findings are expected; the gate decides.
    }
    if (existsSync(out)) sarifs.push(out);
  }

  const runs = sarifs.map((f) => JSON.parse(readFileSync(f, "utf8")).runs || []).flat();
  writeFileSync(join(SARIF_DIR, "skillspector.sarif"), JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs,
  }));

  const results = runs.flatMap((r) => r.results || []);
  const byRule = {};
  let highSignal = 0;
  for (const res of results) {
    const id = String(res.ruleId || "?").split("/").pop();
    byRule[id] = (byRule[id] || 0) + 1;
    if (GATE_RULES.has(id)) highSignal++;
  }

  const lines = [
    "# Skill verification",
    "",
    `- Base: \`${base}\``,
    `- Changed pstack skills: ${delta.skills.length ? delta.skills.map((s) => `\`${s}\``).join(", ") : "(none)"}`,
    `- Lockfile changed: ${delta.lockChanged ? "yes (external skills rescanned)" : "no"}`,
    `- APM audit: \`apm install --frozen\` + \`apm audit --ci\` (see the \`apm-audit\` SARIF in Code Scanning)`,
    `- SkillSpector findings (after baseline): ${results.length}`,
    `- High-signal findings (gate): ${highSignal}`,
    "",
    "## Findings by rule",
    "",
    "| Rule | Count |",
    "|---|---|",
    ...Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([r, n]) => `| ${r} | ${n} |`),
  ];
  writeFileSync(REPORT, lines.join("\n") + "\n");
  writeFileSync(GATE_FILE, JSON.stringify({ highSignal, changed: delta.skills.length, lockChanged: delta.lockChanged }));
  log(`high-signal findings: ${highSignal}`);
}

// --- post to the PR (upsert) ------------------------------------------------
function post(pr) {
  if (!existsSync(REPORT)) throw new Error("no report; run verify first");
  const body = `${MARKER}\n${readFileSync(REPORT, "utf8")}`;
  let existing = "";
  try {
    existing = run("gh", [
      "api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--paginate",
      "-q", `[.[] | select(.body | startswith("${MARKER}")) | .id] | .[0]`,
    ]).trim();
  } catch {
    existing = "";
  }
  if (existing && existing !== "null") {
    run("gh", ["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${existing}`, "-f", `body=${body}`]);
    log(`updated PR #${pr} comment ${existing}`);
  } else {
    run("gh", ["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr}/comments`, "-f", `body=${body}`]);
    log(`posted PR #${pr} comment`);
  }
}

// --- main -------------------------------------------------------------------
if (process.argv.includes("--post")) {
  post(flag("post"));
} else if (process.argv.includes("--gate")) {
  const g = existsSync(GATE_FILE) ? JSON.parse(readFileSync(GATE_FILE, "utf8")) : { highSignal: 0 };
  if (g.highSignal > 0) {
    process.stderr.write(`[skills-verify] gate failed: ${g.highSignal} high-signal finding(s)\n`);
    process.exit(1);
  }
  process.stderr.write("[skills-verify] gate passed\n");
} else {
  verify();
}
