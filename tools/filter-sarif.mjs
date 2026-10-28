#!/usr/bin/env node
// Apply tools/skillspector-baseline.yaml to a SkillSpector/APM SARIF file.
//
//   node tools/filter-sarif.mjs <input.sarif> <output.sarif> [baseline.yaml]
//
// Writes the filtered SARIF and prints a JSON summary to stdout:
//   { total, active, suppressed, byLevel, effectiveExit }
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterSarif, parseBaseline, splitFindings } from "./skillspector-baseline.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [input, output, baselineArg] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node tools/filter-sarif.mjs <input.sarif> <output.sarif> [baseline.yaml]");
  process.exit(2);
}

const baseline = parseBaseline(baselineArg || join(ROOT, "tools", "skillspector-baseline.yaml"));
const sarif = JSON.parse(readFileSync(input, "utf8"));
const results = (sarif.runs || []).flatMap((run) => run.results || []);
const { active, suppressed } = splitFindings(results, baseline);

writeFileSync(output, `${JSON.stringify(filterSarif(sarif, baseline), null, 2)}\n`);

const byLevel = {};
for (const finding of active) byLevel[finding.level] = (byLevel[finding.level] || 0) + 1;
const effectiveExit = byLevel.error ? 1 : byLevel.warning ? 2 : 0;
console.log(
  JSON.stringify(
    {
      total: results.length,
      active: active.length,
      suppressed: suppressed.length,
      byLevel,
      effectiveExit,
    },
    null,
    2,
  ),
);
