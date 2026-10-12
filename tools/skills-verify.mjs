#!/usr/bin/env node
// Verify a skill-update branch through APM and post the result to its PR.
//
// Scanning is delegated to APM's built-in external-scanner integration
// (`apm audit --external skillspector`), which runs SkillSpector offline and
// merges its SARIF into APM's own report. We do NOT call SkillSpector
// directly and we keep no bespoke baseline: APM owns the contract.
//
// The delta is the Git diff against the base branch. APM always hands the
// scanner its whole project root, so we stage only the changed skills into a
// throwaway root (outside any apm.yml) and audit there.
//
//   node tools/skills-verify.mjs [--base main]   run checks, write report + gate
//   node tools/skills-verify.mjs --post <PR>      upsert the report as a PR comment
//   node tools/skills-verify.mjs --gate           exit 1 if the gate failed
//
// Requires on PATH: apm, skillspector, git (gh only for --post).
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "pstack-opencode";
const PROJECT_DIR = join(ROOT, PROJECT);
const PSTACK_SKILLS = join(PROJECT_DIR, ".apm", "skills");
const CACHE = join(ROOT, ".cache", "skills-verify");
const STAGE = join(tmpdir(), "skills-verify-root");
const REPORT = join(CACHE, "report.md");
const GATE_FILE = join(CACHE, "gate.json");
const SARIF_OUT = join(CACHE, "apm-audit.sarif");
const MARKER = "<!-- skills-verify -->";

// APM exit codes for `apm audit` (SARIF severity scale): 0 clean, 1 critical
// (error-level), 2 warning, 3 configuration/infrastructure error. Only
// critical findings and infrastructure failures gate; warnings are reported.
const APM_CRITICAL = 1;
const APM_INFRA = 3;

const flag = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : def;
};
const log = (m) => process.stderr.write(`[skills-verify] ${m}\n`);
const run = (cmd, args, cwd = ROOT) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const listDirs = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

// Names of the pstack skills declared in the repo. Anything deployed that is
// not in this set comes from an external package.
const pstackSkillNames = () => new Set(listDirs(PSTACK_SKILLS));

// Roots where `apm install` may have deployed skills (project-local and the
// user-global target dirs).
function deployedRoots() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    join(PROJECT_DIR, ".agents", "skills"),
    join(PROJECT_DIR, ".opencode", "skills"),
    join(PROJECT_DIR, ".claude", "skills"),
    home && join(home, ".config", "opencode", "skills"),
    home && join(home, ".agents", "skills"),
  ].filter((d) => d && existsSync(d));
}

// --- delta: only what this branch changed vs the base -----------------------
function changedTargets(base) {
  // Compare the working tree to the base: update runs (`apm update`, the pstack
  // regen) leave uncommitted changes that a commit-to-commit diff would miss,
  // while a committed PR checkout sees the same set either way.
  const changed = run("git", ["diff", "--name-only", base])
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

// Stage the changed skills into a minimal root. APM audits its project root,
// so the root is stand-in for the delta.
function stage(delta) {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  const staged = [];
  for (const name of delta.skills) {
    const src = join(PSTACK_SKILLS, name);
    if (!existsSync(src)) continue;
    cpSync(src, join(STAGE, name), { recursive: true });
    staged.push(name);
  }
  // A lockfile change refreshes external packages; stage every deployed skill
  // that is not part of pstack (their names are not in the repo).
  if (delta.lockChanged) {
    const pstack = pstackSkillNames();
    for (const root of deployedRoots()) {
      for (const name of listDirs(root)) {
        if (pstack.has(name) || staged.includes(name)) continue;
        cpSync(join(root, name), join(STAGE, name), { recursive: true });
        staged.push(name);
      }
    }
  }
  return staged;
}

// --- run --------------------------------------------------------------------
function verify() {
  const base = flag("base", "main");
  mkdirSync(CACHE, { recursive: true });

  const delta = changedTargets(base);
  log(`changed pstack skills: ${delta.skills.join(", ") || "(none)"}; lock changed: ${delta.lockChanged}`);

  if (delta.skills.length === 0 && !delta.lockChanged) {
    writeFileSync(REPORT, "# Skill verification\n\nNo skill changes on this branch.\n");
    writeFileSync(GATE_FILE, JSON.stringify({ fail: false, reason: "no changes", staged: [] }));
    return;
  }

  // Materialise the lock-pinned skills so external package contents exist.
  log("apm install --frozen");
  run("apm", ["install", "--frozen"], PROJECT_DIR);

  const staged = stage(delta);
  log(`staged for audit: ${staged.join(", ") || "(none)"}`);

  if (staged.length === 0) {
    writeFileSync(REPORT, "# Skill verification\n\nNo changed skills could be staged for auditing.\n");
    writeFileSync(GATE_FILE, JSON.stringify({ fail: false, reason: "nothing staged", staged }));
    return;
  }

  // Enable APM's external-scanner integration, then run one audit over the
  // staged delta. APM invokes SkillSpector (offline, deterministic) and merges
  // its findings into the report.
  run("apm", ["experimental", "enable", "external-scanners"]);
  rmSync(SARIF_OUT, { force: true });
  log("apm audit --external skillspector");
  const audit = spawnSync(
    "apm",
    ["audit", "--external", "skillspector", "--format", "sarif", "--output", SARIF_OUT],
    { cwd: STAGE, encoding: "utf8" },
  );
  if (audit.status !== 0 && audit.stdout) process.stderr.write(audit.stdout);
  const exitCode = audit.status;

  let results = [];
  if (existsSync(SARIF_OUT)) {
    try {
      results = JSON.parse(readFileSync(SARIF_OUT, "utf8")).runs?.flatMap((r) => r.results || []) ?? [];
    } catch (err) {
      log(`could not parse APM SARIF: ${err.message}`);
    }
  }

  const byRule = new Map();
  const byLevel = {};
  for (const res of results) {
    const rule = String(res.ruleId || "?").split("/").pop();
    const level = res.level || "?";
    byLevel[level] = (byLevel[level] || 0) + 1;
    byRule.set(rule, (byRule.get(rule) || 0) + 1);
  }
  const critical = byLevel.error || 0;
  const fail = exitCode === APM_CRITICAL || exitCode === APM_INFRA || exitCode === null;

  const ruleRows = [...byRule.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `| \`${r}\` | ${n} |`);

  const lines = [
    "# Skill verification",
    "",
    "Scanned through APM's external-scanner integration: `apm audit --external skillspector`",
    "(APM runs SkillSpector offline and merges its SARIF into the report).",
    "",
    `- Base: \`${base}\``,
    `- Changed pstack skills: ${delta.skills.length ? delta.skills.map((s) => `\`${s}\``).join(", ") : "(none)"}`,
    `- Lockfile changed: ${delta.lockChanged ? "yes (external skills staged)" : "no"}`,
    `- Staged for audit: ${staged.map((s) => `\`${s}\``).join(", ")}`,
    `- APM audit exit code: ${exitCode} (\`0\` clean, \`1\` critical, \`2\` warning, \`3\` infrastructure)`,
    `- Findings: ${results.length} (error ${critical}, warning ${byLevel.warning || 0}, note ${byLevel.note || 0})`,
    `- Gate: ${fail ? "❌ failed (critical findings or infrastructure error)" : "✅ passed"}`,
    "",
    "## Findings by rule",
    "",
    "| Rule | Count |",
    "|---|---|",
    ...(ruleRows.length ? ruleRows : ["| _(none)_ | 0 |"]),
  ];
  writeFileSync(REPORT, lines.join("\n") + "\n");
  writeFileSync(
    GATE_FILE,
    JSON.stringify({ fail, exitCode, findings: results.length, critical, staged, lockChanged: delta.lockChanged }),
  );
  log(`apm audit exit=${exitCode}; findings=${results.length} (error ${critical}); gate ${fail ? "FAIL" : "pass"}`);
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
  const g = existsSync(GATE_FILE) ? JSON.parse(readFileSync(GATE_FILE, "utf8")) : { fail: false };
  if (g.fail) {
    process.stderr.write(`[skills-verify] gate failed (apm audit exit=${g.exitCode}, critical=${g.critical ?? "?"})\n`);
    process.exit(1);
  }
  process.stderr.write("[skills-verify] gate passed\n");
} else {
  verify();
}
