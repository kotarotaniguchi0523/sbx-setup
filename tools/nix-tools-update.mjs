#!/usr/bin/env node
// Refresh the pinned CLI versions + release-asset hashes in flake.nix.
//
//   node tools/nix-tools-update.mjs
//
// For each tool it resolves the latest release, reads that release's
// checksums.txt, and rewrites the `<tool>Version` line and the `<tool>Assets`
// block in flake.nix. Idempotent: it makes no change when already up to date.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLAKE = join(ROOT, "flake.nix");
const API = "https://api.github.com";
const VERSION_INTERP = "${sisakulintVersion}";

function token() {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) if (process.env[k]) return process.env[k];
  try {
    return execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const headers = { Accept: "application/vnd.github+json", "User-Agent": "nix-tools-update" };
const tokenValue = token();
if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;

async function latestTag(repo, pattern) {
  if (!pattern) {
    const r = await fetch(`${API}/repos/${repo}/releases/latest`, { headers });
    if (!r.ok) throw new Error(`${repo}: ${r.status}`);
    return (await r.json()).tag_name;
  }
  const r = await fetch(`${API}/repos/${repo}/releases?per_page=30`, { headers });
  if (!r.ok) throw new Error(`${repo}: ${r.status}`);
  const hit = ((await r.json()) || []).find((x) => pattern.test(x.tag_name));
  if (!hit) throw new Error(`${repo}: no release matching ${pattern}`);
  return hit.tag_name;
}

async function checksums(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const map = {};
  for (const line of (await r.text()).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) map[m[2]] = m[1];
  }
  return map;
}

const SYSTEMS = ["x86_64-linux", "aarch64-linux", "x86_64-darwin", "aarch64-darwin"];

const tools = [
  {
    name: "waza",
    versionVar: "wazaVersion",
    blockVar: "wazaAssets",
    latest: () => latestTag("microsoft/waza", /^v\d+\.\d+\.\d+$/),
    checksumsUrl: (tag) => `https://github.com/microsoft/waza/releases/download/${tag}/checksums.txt`,
    names: () => ({
      "x86_64-linux": "waza-linux-amd64",
      "aarch64-linux": "waza-linux-arm64",
      "x86_64-darwin": "waza-darwin-amd64",
      "aarch64-darwin": "waza-darwin-arm64",
    }),
  },
  {
    name: "ax",
    versionVar: "axVersion",
    blockVar: "axAssets",
    latest: () => latestTag("yusukebe/ax"),
    checksumsUrl: (tag) => `https://github.com/yusukebe/ax/releases/download/${tag}/checksums.txt`,
    names: () => ({
      "x86_64-linux": "ax-linux-x64",
      "aarch64-linux": "ax-linux-arm64",
      "x86_64-darwin": "ax-darwin-x64",
      "aarch64-darwin": "ax-darwin-arm64",
    }),
  },
  {
    name: "sisakulint",
    versionVar: "sisakulintVersion",
    blockVar: "sisakulintAssets",
    latest: () => latestTag("sisaku-security/sisakulint"),
    checksumsUrl: (tag) =>
      `https://github.com/sisaku-security/sisakulint/releases/download/${tag}/sisakulint_${tag.replace(/^v/, "")}_checksums.txt`,
    names: (tag) => {
      const n = tag.replace(/^v/, "");
      return {
        "x86_64-linux": `sisakulint_${n}_linux_amd64.tar.gz`,
        "aarch64-linux": `sisakulint_${n}_linux_arm64.tar.gz`,
        "x86_64-darwin": `sisakulint_${n}_darwin_amd64.tar.gz`,
        "aarch64-darwin": `sisakulint_${n}_darwin_arm64.tar.gz`,
      };
    },
    // flake.nix interpolates the version into these names.
    nameExpr: (tag, file) =>
      file.replace(`_${tag.replace(/^v/, "")}_`, `_${VERSION_INTERP}_`),
  },
];

async function main() {
  let flake = readFileSync(FLAKE, "utf8");
  let changed = false;

  for (const tool of tools) {
    const tag = await tool.latest();
    const version = tag.replace(/^v/, "");
    const sums = await checksums(tool.checksumsUrl(tag));
    const names = tool.names(tag);

    const entries = SYSTEMS.map((sys) => {
      const file = names[sys];
      const sha = sums[file];
      if (!sha) throw new Error(`${tool.name}: checksum for ${file} not found`);
      const nameExpr = tool.nameExpr ? tool.nameExpr(tag, file) : file;
      return `            ${sys} = { name = "${nameExpr}"; sha256 = "${sha}"; };`;
    }).join("\n");

    const afterVersion = flake.replace(
      new RegExp(`(\\b${tool.versionVar} = ")[^"]*(";)`),
      `$1${version}$2`,
    );
    if (afterVersion !== flake) {
      flake = afterVersion;
      changed = true;
    }

    const blockRe = new RegExp(`(\\n\\s*${tool.blockVar} = \\{)[\\s\\S]*?(\\n\\s*\\};)`);
    if (!blockRe.test(flake)) throw new Error(`flake.nix: ${tool.blockVar} block not found`);
    const afterBlock = flake.replace(blockRe, `$1\n${entries}$2`);
    if (afterBlock !== flake) {
      flake = afterBlock;
      changed = true;
    }

    process.stderr.write(`[nix-tools-update] ${tool.name} -> ${tag}\n`);
  }

  if (changed) {
    writeFileSync(FLAKE, flake);
    process.stderr.write("[nix-tools-update] flake.nix updated\n");
  } else {
    process.stderr.write("[nix-tools-update] already up to date\n");
  }
}

main().catch((err) => {
  process.stderr.write(`[nix-tools-update] error: ${err.message}\n`);
  process.exit(1);
});
