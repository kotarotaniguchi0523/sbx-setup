#!/usr/bin/env node
// Repo-local sisakulint launcher.
//
// Installs sisakulint — and, when no Go toolchain is found, a portable Go — into
// the gitignored .tools/ directory. Nothing is installed globally. Then it runs
// sisakulint from the repo root.
//
//   node tools/sisakulint.mjs                 # lint .github/workflows (exit 1 on findings)
//   node tools/sisakulint.mjs -fix dry-run    # preview auto-fixes
//   node tools/sisakulint.mjs -fix on         # apply auto-fixes in place
//   node tools/sisakulint.mjs -init           # write .github/sisakulint.yaml
//   node tools/sisakulint.mjs --install-only  # only install, do not scan
//
// Versions are pinned in tools/sisakulint.version and tools/golang.version
// (kept up to date by Renovate).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = join(ROOT, ".tools");
const BIN_DIR = join(TOOLS, "bin");
const IS_WIN = process.platform === "win32";
const BIN = join(BIN_DIR, IS_WIN ? "sisakulint.exe" : "sisakulint");
const GO_HOME = join(TOOLS, "go");
const GO_BIN = join(GO_HOME, "bin", IS_WIN ? "go.exe" : "go");

const wantSisaku = readFileSync(join(ROOT, "tools", "sisakulint.version"), "utf8").trim();
const wantGo = readFileSync(join(ROOT, "tools", "golang.version"), "utf8").trim();
const stampFile = join(TOOLS, ".sisakulint.version");

const log = (m) => process.stderr.write(`[sisakulint] ${m}\n`);

function runs(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function goCommand() {
  if (runs("go", ["version"])) return "go";
  if (existsSync(GO_BIN) && runs(GO_BIN, ["version"])) return GO_BIN;
  return null;
}

function tarCommand() {
  if (IS_WIN) {
    const sys = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (existsSync(sys)) return sys; // bsdtar (handles .zip)
  }
  return "tar";
}

function downloadGo() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const osPart = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const ext = IS_WIN ? "zip" : "tar.gz";
  const url = `https://go.dev/dl/go${wantGo}.${osPart}-${arch}.${ext}`;
  const tmp = join(TOOLS, `go.${ext}`);
  log(`portable Go ${wantGo} not found; downloading (${osPart}-${arch})`);
  mkdirSync(TOOLS, { recursive: true });
  execFileSync("curl", ["-fsSL", "-o", tmp, url], { stdio: "inherit" });
  rmSync(GO_HOME, { recursive: true, force: true });
  log("extracting Go");
  execFileSync(tarCommand(), IS_WIN ? ["-xf", tmp, "-C", TOOLS] : ["-xzf", tmp, "-C", TOOLS], {
    stdio: "inherit",
  });
  rmSync(tmp, { force: true });
  if (!existsSync(GO_BIN)) throw new Error(`Go extraction failed (expected ${GO_BIN})`);
}

function ensureGo() {
  const found = goCommand();
  if (found) return found;
  downloadGo();
  const go = goCommand();
  if (!go) throw new Error(`portable Go not runnable at ${GO_BIN}`);
  return go;
}

function ensureSisakulint() {
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : "";
  if (existsSync(BIN) && stamp === wantSisaku) return;
  const go = ensureGo();
  log(`installing sisakulint v${wantSisaku} into ${BIN_DIR}`);
  mkdirSync(BIN_DIR, { recursive: true });
  execFileSync(
    go,
    ["install", `github.com/sisaku-security/sisakulint/cmd/sisakulint@v${wantSisaku}`],
    { stdio: "inherit", env: { ...process.env, GOBIN: BIN_DIR } },
  );
  writeFileSync(stampFile, `${wantSisaku}\n`);
}

const args = process.argv.slice(2);
ensureSisakulint();
if (args.includes("--install-only")) process.exit(0);

// Repo policy: rules listed in tools/sisakulint.ignore are always silenced
// unless the caller passes -ignore explicitly.
const ignoreFile = join(ROOT, "tools", "sisakulint.ignore");
const ignores = existsSync(ignoreFile)
  ? readFileSync(ignoreFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  : [];
const runArgs = [...args];
if (!args.some((a) => a === "-ignore" || a.startsWith("-ignore="))) {
  for (const rule of ignores) runArgs.push("-ignore", rule);
}

// Lift the GitHub API rate limit when a token can be found (gh auth login etc.).
const env = { ...process.env };
if (!env.SISAKULINT_GITHUB_TOKEN && !env.GITHUB_TOKEN && !env.GH_TOKEN) {
  try {
    const token = execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (token) env.SISAKULINT_GITHUB_TOKEN = token;
  } catch {
    // no gh / not logged in; unauthenticated rate limit applies
  }
}

try {
  execFileSync(BIN, runArgs, { stdio: "inherit", cwd: ROOT, env });
} catch (err) {
  process.exit(typeof err.status === "number" ? err.status : 1);
}
