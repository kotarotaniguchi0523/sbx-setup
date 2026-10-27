#!/usr/bin/env node
// Verify a skill-update branch through APM and post the result to its PR.
//
// Scanning is delegated to APM's built-in external-scanner integration
// (`apm audit --external skillspector`), which runs SkillSpector offline and
// merges its SARIF into APM's own report. We do NOT call SkillSpector
// directly; reviewed false positives are applied from
// tools/skillspector-baseline.yaml.
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
import { parseBaseline, splitFindings } from "./skillspector-baseline.mjs";

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
  // Include newly generated, not-yet-added pstack skills from update runs.
  const changed = [...new Set([
    ...run("git", ["diff", "--name-only", base]).split("\n"),
    ...run("git", ["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].map((s) => s.trim()).filter(Boolean))];
  const skills = new Set();
  let lockChanged = false;
  let auditAll = process.argv.includes("--all");
  for (const path of changed) {
    if (path === "tools/skillspector-baseline.yaml" ||
        path === "tools/skillspector-baseline.mjs" ||
        path === "tools/skills-verify.mjs" ||
        path === ".github/workflows/skills-verify.yml") auditAll = true;
    if (path.startsWith(`${PROJECT}/.apm/skills/`)) {
      const name = path.slice(`${PROJECT}/.apm/skills/`.length).split("/")[0];
      if (name) skills.add(name);
    }
    if (path === `${PROJECT}/apm.lock.yaml`) lockChanged = true;
  }
  return { skills: [...skills], lockChanged, auditAll };
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
  for (const path of run("git", ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    const m = path.match(new RegExp(`^${PROJECT}/\\.apm/skills/([^/]+)/`));
    if (m && !status.has(m[1])) status.set(m[1], "A");
  }
  return status;
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
  // A baseline/scanner change must re-evaluate all skills, not silently skip.
  if (delta.auditAll) {
    for (const name of listDirs(PSTACK_SKILLS)) {
      if (staged.includes(name)) continue;
      cpSync(join(PSTACK_SKILLS, name), join(STAGE, name), { recursive: true });
      staged.push(name);
    }
  }
  // A lockfile change refreshes external packages; audit all deployed external skills.
  if (delta.lockChanged || delta.auditAll) {
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

  if (delta.skills.length === 0 && !delta.lockChanged && !delta.auditAll) {
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
    writeFileSync(GATE_FILE, JSON.stringify({ fail: true, reason: "changed skills could not be staged", staged }));
    return;
  }

  // APM's SkillSpector adapter imposes a fixed 300s timeout on each
  // subprocess, so an audit of all ~50 installed skills can fail even when
  // the scanner is correctly installed. Split the stage into independent,
  // bounded batches and merge their SARIF runs without dropping findings.
  run("apm", ["experimental", "enable", "external-scanners"]);
  rmSync(SARIF_OUT, { force: true });
  const batchSize = 5;
  const groups = [];
  for (let i = 0; i < staged.length; i += batchSize) groups.push(staged.slice(i, i + batchSize));
  log(`auditing ${staged.length} skills in ${groups.length} batches of at most ${batchSize}`);

  const mergedRuns = [];
  let sarifValid = true;
  let exitCode = 0;
  let scannedCount = 0;
  let auditError = "";
  for (const [i, names] of groups.entries()) {
    const batchRoot = join(tmpdir(), `skills-verify-batch-${process.pid}-${i}`);
    const batchSarif = join(CACHE, `apm-audit-batch-${i}.sarif`);
    rmSync(batchRoot, { recursive: true, force: true });
    rmSync(batchSarif, { force: true });
    mkdirSync(batchRoot, { recursive: true });
    try {
      for (const name of names) cpSync(join(STAGE, name), join(batchRoot, name), { recursive: true });
      log(`batch ${i + 1}/${groups.length}: ${names.join(", ")}`);
      const audit = spawnSync(
        "apm",
        ["audit", "--external", "skillspector", "--no-external-llm", "--format", "sarif", "--output", batchSarif],
        { cwd: batchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      const code = audit.status;
      if (code === null || ![0, 1, 2].includes(code) || audit.error) {
        exitCode = 3;
        auditError = `batch ${i + 1} (${names.join(", ")}) failed: ${audit.error?.message || `exit ${code}`}`;
        // APM redacts scanner error messages, but subprocess streams were
        // previously discarded and masked the underlying timeout.
        for (const output of [audit.stderr, audit.stdout]) {
          if (output?.trim()) log(output.trim().slice(-5000));
        }
        log(auditError);
        sarifValid = false;
        break;
      }
      if (code === 1) exitCode = 1;
      else if (code === 2 && exitCode === 0) exitCode = 2;
      if (!existsSync(batchSarif)) {
        auditError = `batch ${i + 1} produced no SARIF`;
        sarifValid = false;
        break;
      }
      let document;
      try {
        document = JSON.parse(readFileSync(batchSarif, "utf8"));
        if (document.version !== "2.1.0" || !Array.isArray(document.runs)) {
          throw new Error("invalid SARIF 2.1.0 document");
        }
      } catch (err) {
        auditError = `batch ${i + 1}: ${err.message}`;
        sarifValid = false;
        break;
      }
      mergedRuns.push(...document.runs);
      scannedCount += names.length;
      log(`batch ${i + 1} complete (exit=${code})`);
    } finally {
      rmSync(batchRoot, { recursive: true, force: true });
      rmSync(batchSarif, { force: true });
    }
  }
  if (sarifValid && scannedCount === staged.length) {
    writeFileSync(SARIF_OUT, JSON.stringify({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: mergedRuns,
    }, null, 2) + "\n");
  } else {
    sarifValid = false;
    if (!auditError) auditError = `incomplete audit: ${scannedCount}/${staged.length} skills scanned`;
    log(auditError);
    exitCode = 3;
  }
  const results = mergedRuns.flatMap((r) => r.results || []);

  // Extract findings with their location, then apply the baseline: a matching
  // finding is reported under "Suppressed (baseline)" and never gates.
  const baseline = parseBaseline(BASELINE);
  const { active, suppressed } = splitFindings(results, baseline);
  const byLevel = {};
  const byLevelRule = new Map();
  for (const f of active) {
    byLevel[f.level] = (byLevel[f.level] || 0) + 1;
    const key = `${f.level}\u0000${f.rule}`;
    byLevelRule.set(key, (byLevelRule.get(key) || 0) + 1);
  }
  const critical = byLevel.error || 0;
  const fail = critical > 0 || exitCode === APM_INFRA || exitCode === null || !sarifValid;

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
    `- Batches: ${groups.length}; completed: ${scannedCount}/${staged.length} skills`,
    ...(auditError ? [`- Scanner error: ${auditError}`] : []),
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
  if (!existsSync(GATE_FILE)) throw new Error("missing gate.json: verification did not complete");
  const g = JSON.parse(readFileSync(GATE_FILE, "utf8"));
  if (g.fail) {
    process.stderr.write(`[skills-verify] gate failed (apm audit exit=${g.exitCode}, critical=${g.critical ?? "?"})\n`);
    process.exit(1);
  }
  process.stderr.write("[skills-verify] gate passed\n");
} else {
  verify();
}
