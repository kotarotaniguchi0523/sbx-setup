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
const BASELINE = join(ROOT, "tools", "skillspector-baseline.yaml");

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

// pstack-opencode version + the pinned upstream ref (for the report header).
function projectInfo() {
  let version = "unknown";
  try {
    const m = readFileSync(join(PROJECT_DIR, "apm.yml"), "utf8").match(/^version:\s*(\S+)/m);
    if (m) version = m[1];
  } catch {
    /* ignore */
  }
  let upstream = "unknown";
  try {
    const s = JSON.parse(readFileSync(join(PROJECT_DIR, "SOURCE.json"), "utf8"));
    upstream = `${s.repository}@${String(s.ref || "unknown").slice(0, 12)}`;
  } catch {
    /* ignore */
  }
  return { version, upstream };
}

// Per-skill change status (A/M/D/R) from `git diff --name-status <base>`.
function changeStatus(base) {
  const status = new Map();
  for (const line of run("git", ["diff", "--name-status", base]).split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(/\t/);
    const code = parts[0][0];
    const path = parts[parts.length - 1];
    const m = path.match(new RegExp(`^${PROJECT}/\\.apm/skills/([^/]+)/`));
    if (!m) continue;
    const name = m[1];
    if (!status.has(name) || code === "A" || code === "D") status.set(name, code);
  }
  return status;
}

// --- baseline (false-positive suppression) ----------------------------------
function unquote(value) {
  return String(value).replace(/^["']|["']$/g, "").trim();
}

// Minimal parser for the baseline's YAML list (rule / path / message / reason).
function parseBaseline() {
  if (!existsSync(BASELINE)) return [];
  const entries = [];
  let cur = null;
  for (const raw of readFileSync(BASELINE, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const start = line.match(/^\s*-\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (start) {
      cur = { [start[1]]: unquote(start[2]) };
      entries.push(cur);
      continue;
    }
    const kv = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv && cur) cur[kv[1]] = unquote(kv[2]);
  }
  return entries;
}

function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

// Returns the matching baseline entry for a finding, or null.
function matchedBaseline(finding, entries) {
  for (const e of entries) {
    if (e.rule && e.rule !== finding.rule) continue;
    if (e.path && !globToRe(e.path).test(finding.uri)) continue;
    if (e.message && !finding.msg.toLowerCase().includes(e.message.toLowerCase())) continue;
    return e;
  }
  return null;
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

  // Extract findings with their location, then apply the baseline: a matching
  // finding is reported under "Suppressed (baseline)" and never gates.
  const findings = results.map((res) => {
    const pl = ((res.locations || [])[0] || {}).physicalLocation || {};
    return {
      level: res.level || "?",
      rule: String(res.ruleId || "?").split("/").pop(),
      uri: (pl.artifactLocation || {}).uri || "",
      line: (pl.region || {}).startLine,
      msg: String((res.message || {}).text || "").replace(/\s+/g, " ").trim(),
    };
  });
  const baseline = parseBaseline();
  const active = [];
  const suppressed = [];
  for (const f of findings) {
    const hit = matchedBaseline(f, baseline);
    if (hit) suppressed.push({ ...f, reason: hit.reason || "baseline" });
    else active.push(f);
  }
  const byLevel = {};
  const byLevelRule = new Map();
  for (const f of active) {
    byLevel[f.level] = (byLevel[f.level] || 0) + 1;
    const key = `${f.level}\u0000${f.rule}`;
    byLevelRule.set(key, (byLevelRule.get(key) || 0) + 1);
  }
  const critical = byLevel.error || 0;
  const fail = critical > 0 || exitCode === APM_INFRA || exitCode === null;

  // Changelog-style header: date, versions, range.
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const { version, upstream } = projectInfo();
  const head = run("git", ["rev-parse", "--short", "HEAD"]).trim();
  const baseShort = run("git", ["rev-parse", "--short", base]).trim();

  // Changes grouped Added / Modified / Removed, like a changelog.
  const statusMap = changeStatus(base);
  const bucket = (letters) =>
    [...statusMap].filter(([, code]) => letters.includes(code)).map(([name]) => name).sort();
  const fmt = (names) => (names.length ? names.map((n) => `\`${n}\``).join(", ") : "_(none)_");

  const findingRows = [...byLevelRule.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const [level, rule] = key.split("\u0000");
      return `| \`${level}\` | \`${rule}\` | ${count} |`;
    });

  // Where each finding was detected, with a permalink to the audited file at
  // HEAD so a human can trace it later. pstack skills map back into the repo;
  // external skills are shown as staged.
  const repoSlug = process.env.GITHUB_REPOSITORY || "";
  const headFull = run("git", ["rev-parse", "HEAD"]).trim();
  const repoSkills = pstackSkillNames();
  const whereCell = (f) => {
    if (!f.uri) return "—";
    const inRepo = repoSkills.has(f.uri.split("/")[0]);
    const path = inRepo ? `${PROJECT}/.apm/skills/${f.uri}` : f.uri;
    const ref = `${path}${f.line ? `:${f.line}` : ""}`;
    return repoSlug
      ? `[\`${ref}\`](https://github.com/${repoSlug}/blob/${headFull}/${path}${f.line ? `#L${f.line}` : ""})`
      : `\`${ref}\``;
  };
  const detailRow = (f) =>
    `| \`${f.level}\` | \`${f.rule}\` | ${whereCell(f)} | ${f.msg.replace(/\|/g, "\\|").slice(0, 160)} |`;
  const detailRows = active.map(detailRow);
  const suppressedRows = suppressed.map(
    (f) =>
      `| \`${f.level}\` | \`${f.rule}\` | ${whereCell(f)} | *(baseline: ${f.reason})* ${f.msg.replace(/\|/g, "\\|").slice(0, 140)} |`,
  );

  const lines = [
    `# Skill verification · ${now}`,
    "",
    `**Version** \`pstack-opencode ${version}\` · upstream \`${upstream}\``,
    `**Range** \`${base}\` (${baseShort}) → \`HEAD\` (${head})`,
    `**Scanner** APM external scanner — \`apm audit --external skillspector\` (offline, deterministic)`,
    `**Baseline** \`tools/skillspector-baseline.yaml\` (${baseline.length} rule(s); ${suppressed.length} suppressed)`,
    "",
    "## Changes",
    "",
    `- **Added**: ${fmt(bucket(["A"]))}`,
    `- **Modified**: ${fmt(bucket(["M", "R"]))}`,
    `- **Removed**: ${fmt(bucket(["D"]))}`,
    `- **Lockfile**: ${delta.lockChanged ? "changed (external skills audited)" : "unchanged"}`,
    `- **Audited**: ${fmt(staged)}`,
    "",
    "## Findings",
    "",
    `- \`apm audit\` exit code: ${exitCode} (\`0\` clean, \`1\` critical, \`2\` warning, \`3\` infrastructure)`,
    `- Active: ${active.length} (error ${critical}, warning ${byLevel.warning || 0}, note ${byLevel.note || 0}) · Suppressed by baseline: ${suppressed.length}`,
    "",
    "| Level | Rule | Count |",
    "|---|---|---|",
    ...(findingRows.length ? findingRows : ["| — | _(none)_ | 0 |"]),
    "",
    "## Findings — details",
    "",
    "Where is relative to the staged audit root; pstack skills mirror `pstack-opencode/.apm/skills/<skill>/`.",
    "",
    "| Level | Rule | Where | Detail |",
    "|---|---|---|---|",
    ...(detailRows.length ? detailRows : ["| — | _(none)_ | — | — |"]),
    "",
    "## Suppressed (baseline)",
    "",
    ...(suppressedRows.length
      ? ["| Level | Rule | Where | Detail |", "|---|---|---|---|", ...suppressedRows]
      : ["_(none)_"]),
    "",
    "## Gate",
    "",
    fail
      ? `❌ **failed** — ${critical} active error-level finding(s), or infrastructure error (exit ${exitCode})`
      : "✅ **passed**",
    "",
    "## Rules",
    "",
    "- Gate: **active** error-level findings (after baseline) → fail; APM infrastructure error (`3`) → fail.",
    "- Baseline: `tools/skillspector-baseline.yaml` suppresses known false positives (rule + path glob + message).",
    "- Delta: `git diff <base>` (working tree included, so uncommitted update runs are seen).",
    "- Scanner: the APM external-scanner contract (`skillspector scan --format sarif --no-llm`).",
  ];
  writeFileSync(REPORT, lines.join("\n") + "\n");
  writeFileSync(
    GATE_FILE,
    JSON.stringify({ fail, exitCode, active: active.length, suppressed: suppressed.length, critical, staged, lockChanged: delta.lockChanged }),
  );
  log(`apm audit exit=${exitCode}; active=${active.length} (error ${critical}); suppressed=${suppressed.length}; gate ${fail ? "FAIL" : "pass"}`);
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
