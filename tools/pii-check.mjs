#!/usr/bin/env node
// Block personal information from being committed.
//
//   node tools/pii-check.mjs --staged   # scan staged (pre-commit)
//   node tools/pii-check.mjs            # scan all tracked files (pre-push)
//
// Patterns live in tools/pii.txt (one JavaScript regex per line).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS_FILE = "tools/pii.txt";

function readPatterns() {
  const p = join(ROOT, PATTERNS_FILE);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((src) => new RegExp(src));
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT }).toString("utf8");
}

function listFiles(staged) {
  const out = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    : git(["ls-files"]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function contentOf(file, staged) {
  try {
    return staged ? git(["show", `:${file}`]) : readFileSync(join(ROOT, file), "utf8");
  } catch {
    return null;
  }
}

const staged = process.argv.includes("--staged");
const patterns = readPatterns();
if (patterns.length === 0) {
  process.stderr.write("[pii] no patterns configured\n");
  process.exit(0);
}

let hits = 0;
for (const file of listFiles(staged)) {
  if (file === PATTERNS_FILE) continue; // the pattern list itself
  const content = contentOf(file, staged);
  if (content == null || content.includes("\u0000")) continue; // missing or binary
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((re) => re.test(lines[i]))) {
      process.stderr.write(`[pii] ${file}:${i + 1}: ${lines[i].trim().slice(0, 160)}\n`);
      hits++;
    }
  }
}

if (hits > 0) {
  process.stderr.write(`[pii] ${hits} potential personal-info match(es) found\n`);
  process.exit(1);
}
process.stderr.write("[pii] clean\n");
