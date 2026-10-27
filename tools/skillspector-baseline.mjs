// Shared SkillSpector false-positive baseline handling.
//
// The APM external-scanner contract does not let us pass SkillSpector's own
// `--baseline`, so callers apply this list to the SARIF that APM returns.
// A match is reported as suppressed and never gates or reaches Code Scanning.
import { existsSync, readFileSync } from "node:fs";

export function parseBaseline(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  let cur = null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
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

function unquote(value) {
  return String(value).replace(/^["']|["']$/g, "").trim();
}

export function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

export function toFinding(result) {
  const pl = ((result.locations || [])[0] || {}).physicalLocation || {};
  return {
    level: result.level || "?",
    rule: String(result.ruleId || "?").split("/").pop(),
    uri: (pl.artifactLocation || {}).uri || "",
    line: (pl.region || {}).startLine,
    msg: String((result.message || {}).text || "").replace(/\s+/g, " ").trim(),
  };
}

// Returns the matching baseline entry for a finding, or null.
export function matchBaseline(finding, entries) {
  for (const e of entries) {
    if (e.rule && e.rule !== finding.rule) continue;
    if (e.path && !globToRe(e.path).test(finding.uri)) continue;
    if (e.message && !finding.msg.toLowerCase().includes(e.message.toLowerCase())) continue;
    return e;
  }
  return null;
}

// Split SARIF results into active and baseline-suppressed findings.
export function splitFindings(results, entries) {
  const active = [];
  const suppressed = [];
  for (const result of results) {
    const finding = toFinding(result);
    const hit = matchBaseline(finding, entries);
    if (hit) suppressed.push({ ...finding, reason: hit.reason || "baseline" });
    else active.push(finding);
  }
  return { active, suppressed };
}

// Return a copy of the SARIF document with suppressed results removed.
export function filterSarif(sarif, entries) {
  return {
    ...sarif,
    runs: (sarif.runs || []).map((run) => ({
      ...run,
      results: (run.results || []).filter(
        (result) => !matchBaseline(toFinding(result), entries),
      ),
    })),
  };
}
