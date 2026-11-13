#!/usr/bin/env node
// Refresh the pinned CLI versions + release-asset hashes in flake.nix
// (waza / ax / sisakulint / depgraph, and the images' official Node.js v26).
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
const SISAKULINT_INTERP = "${sisakulintVersion}";
const DEPGRAPH_INTERP = "${depgraphVersion}";
const NODE_INTERP = "${nodeVersion}";
const NODE_MAJOR = "v26.";

async function latestNode() {
  const r = await fetch("https://nodejs.org/dist/index.json", { headers: { "User-Agent": "nix-tools-update" } });
  if (!r.ok) throw new Error(`nodejs.org index: ${r.status}`);
  const hit = (await r.json()).find((x) => x.version.startsWith(NODE_MAJOR));
  if (!hit) throw new Error(`nodejs.org: no ${NODE_MAJOR}x release`);
  return hit.version;
}

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
      file.replace(`_${tag.replace(/^v/, "")}_`, `_${SISAKULINT_INTERP}_`),
  },
  {
    // No checksums.txt: every archive has its own <asset>.sha256, and there is
    // no Intel macOS build.
    name: "depgraph",
    versionVar: "depgraphVersion",
    blockVar: "depgraphAssets",
    systems: ["x86_64-linux", "aarch64-linux", "aarch64-darwin"],
    latest: () => latestTag("TamaT-LLC/depgraph-cli"),
    checksumsFor: async (tag, names) => {
      const map = {};
      for (const file of Object.values(names)) {
        Object.assign(map, await checksums(`https://github.com/TamaT-LLC/depgraph-cli/releases/download/${tag}/${file}.sha256`));
      }
      return map;
    },
    names: (tag) => {
      const n = tag.replace(/^v/, "");
      return {
        "x86_64-linux": `depgraph-${n}-x86_64-unknown-linux-gnu.tar.gz`,
        "aarch64-linux": `depgraph-${n}-aarch64-unknown-linux-gnu.tar.gz`,
        "aarch64-darwin": `depgraph-${n}-aarch64-apple-darwin.tar.gz`,
      };
    },
    nameExpr: (tag, file) =>
      file.replace(`-${tag.replace(/^v/, "")}-`, `-${DEPGRAPH_INTERP}-`),
  },
  {
    // Newest release of the v26 line, from nodejs.org's own index and
    // SHASUMS256.txt.
    name: "nodejs",
    versionVar: "nodeVersion",
    blockVar: "nodeAssets",
    latest: latestNode,
    checksumsUrl: (tag) => `https://nodejs.org/dist/${tag}/SHASUMS256.txt`,
    names: (tag) => ({
      "x86_64-linux": `node-${tag}-linux-x64.tar.xz`,
      "aarch64-linux": `node-${tag}-linux-arm64.tar.xz`,
      "x86_64-darwin": `node-${tag}-darwin-x64.tar.xz`,
      "aarch64-darwin": `node-${tag}-darwin-arm64.tar.xz`,
    }),
    nameExpr: (tag, file) => file.replace(`node-${tag}-`, `node-v${NODE_INTERP}-`),
  },
];

async function main() {
  let flake = readFileSync(FLAKE, "utf8");
  let changed = false;

  for (const tool of tools) {
    const tag = await tool.latest();
    const version = tag.replace(/^v/, "");
    const names = tool.names(tag);
    const sums = tool.checksumsFor
      ? await tool.checksumsFor(tag, names)
      : await checksums(tool.checksumsUrl(tag));

    const entries = (tool.systems ?? SYSTEMS).map((sys) => {
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
