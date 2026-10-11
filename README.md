# sbx 共通環境 セットアップ

Docker Sandboxes (sbx) のテンプレートと共通設定。Skill はすべて **APM（Agent Package Manager）経由**。
入口は **`sbx env`**（宣言的ファイル + 1コマンド）で、ビルドから sbx への取り込みまで一気通貫。

## 構成

```
sbx-setup/
├── sbxenv.yaml           # 入口。agent / template / lifecycle（ビルド＋取り込み）
├── .dockerignore
├── common-opencode/      # OpenCode 用 v3 workload kit（ビルド内で pstack 変換）
│   ├── common-opencode.yaml
│   └── common-opencode.dockerfile
├── common-codex/         # Codex 用 v3 workload kit
│   ├── common-codex.yaml
│   └── common-codex.dockerfile
└── pstack-opencode/      # 本家 pstack を OpenCode 向けに変換する APM パッケージ
    ├── apm.yml
    ├── opencode/AGENTS.md
    └── tools/convert.mjs  # Repomix で本家を取得し .apm/ を生成
```

生成物（`.apm/`、`*.tar`）はコミットしない。

## 決定事項

| 項目 | 決定 |
|------|------|
| 入口 | `sbx env run` / `sbx env create`（`sbx-setup/sbxenv.yaml`） |
| エージェント | **OpenCode v2**（beta, `@opencode/cli`）既定 / codex（`--env-arg agent=codex`） |
| MCP | context7 のみ |
| CLI | git/gh/node/npm/pnpm/python, uv, mise, nix, cf, mo, difit, waza, apm, agent-browser, ax |
| Skill | すべて APM 経由（sbx skills ストアは使わない） |
| pstack | ビルド時に本家 `cursor/plugins/pstack` を OpenCode 向けに変換（opencode のみ） |
| 変換の実行 | **sbx テンプレートのビルド内**（Dockerfile 内で `node tools/convert.mjs`） |
| ビルド/取り込み | `lifecycle.initialize`（host コマンド）で buildx → image save → `sbx template load` |
| routing | `~/.config/opencode/AGENTS.md`（常設指示） |
| サイト許可 | 現状維持 + brew/nix/cloudflare |
| 不採用 | PowerShell / WSL / actrun / GitHub Actions / Docker Compose |

## 実行（入口は `sbx env`）

**どこからでも（パス指定なし）**:

```bat
sbx env run
```

`~/.sbxenv.yaml`（ユーザー既定）を読み、**カレントディレクトリをワークスペースにマウント**して、
テンプレートのビルド（並列 bake）→ save → load → サンドボックス作成 までを1コマンドで行う。
サンドボックス名は自動（`<agent>-<workspace-basename>`）。

opencode / codex を切り替えたい場合は、リポジトリ同梱のパラメータ付きファイルを使う:

```bat
sbx env run sbx-setup\sbxenv.yaml --name common-opencode --env-arg workspace=C:\Users\r02ta\projects
sbx env run sbx-setup\sbxenv.yaml --name common-codex ^
  --env-arg agent=codex --env-arg template=common-codex:dev --env-arg workspace=C:\Users\r02ta\projects
```

未アタッチで作成だけなら `sbx env create --auto-approve ...`、削除は `sbx env rm ...`。

- いずれのファイルも `sandboxOptions.skills: off`（sbx の共有 skills ストアを使わない。APM で焼き込んだ skills と衝突するため）。
- lifecycle があるため既定では毎回プラン承認が必要。`sbx settings set env.rememberHostCommands true` か `--auto-approve` で省略可。

## `lifecycle.initialize` が行うこと

サンドボックスの作成前に **host 側**で実行される:

1. `docker buildx bake`（`docker-bake.hcl`）で `common-opencode` / `common-codex` を**並列ビルド**
   （**opencode はこの中で本家 pstack の変換も実行**）
2. `docker image save` で**両イメージを1つの tar** に保存
3. `sbx template load` **1回**で sbx のランタイムへ取り込み

> `lifecycle.initialize` のコマンドは**順次実行**（並列不可）なので、並列化は `docker buildx bake`
> の複数ターゲットで行う。`sbx template load` は複数イメージ入りの tar を一括で読み込めるため、
> save/load は各1回にまとめている。

## 手動でビルド / 取り込みする場合

```bat
cd sbx-setup
docker buildx build -f common-opencode\common-opencode.yaml -t common-opencode:dev .
docker buildx build -f common-codex\common-codex.yaml       -t common-codex:dev    .\common-codex

docker image save common-opencode:dev -o "%TEMP%\common-opencode.tar"
docker image save common-codex:dev    -o "%TEMP%\common-codex.tar"
sbx template load "%TEMP%\common-opencode.tar"
sbx template load "%TEMP%\common-codex.tar"
sbx template ls
```

## APM で導入される Skill

| パッケージ | 形 | 対象 | skills |
|---|---|---|---|
| `pstack-opencode` | ビルド内生成（ローカル `/opt`） | opencode | 52 |
| `mizchi/explainer` | GitHub 依存 | opencode / codex | 5 |
| `nanaism/yomiyasu` | GitHub 依存 | opencode / codex | 1 |
| `vercel-labs/agent-browser` | GitHub 依存 | opencode / codex | 1 |
| `yusukebe/ax` | GitHub 依存 | opencode / codex | 1 |
| `microsoft/waza` | GitHub 依存 | opencode / codex | 3 |
| `microsoft/apm`（`apm-usage`） | GitHub 依存（パス指定） | opencode / codex | 1 |

配置先: opencode → `~/.config/opencode/skills/`（agents は `~/.config/opencode/agents/`）、
codex → `~/.agents/skills/`。

### pstack の変換（自動・決定的）

`pstack-opencode/tools/convert.mjs` が `npx repomix --remote cursor/plugins --include "pstack/**"` で
本家を取得し、frontmatter 正規化・Cursor 専用フィールド除去・**本文の Claude ツール名／パス置換**・
`references/opencode-tools.md` 注入・agents の subagent 化・routing 生成を行って `.apm/` を出力する。
モデル名（`opus`/`grok`）や `/loop`、`subagent_type` は複合IDを壊すため残置し、対応表で読み替える。

## ネットワーク許可（追加分）

```bat
sbx policy allow network "formulae.brew.sh:443,cache.nixos.org:443,nixos.org:443,api.cloudflare.com:443"
```

## MCP

```bat
sbx mcp ls   REM context7 が ready であること
```

context7 の API キーは平文保存を避け、`sbx secret set` を使う。

## GitHub 認証（gh / git）

サンドボックス内で `gh auth login` は不要。ホスト側プロキシが GitHub トークンを `GH_TOKEN` として注入する（opencode/codex 両 descriptor で `github` credential を宣言済み）。

```bat
sbx secret set github --command "gh auth token"
```

## ローカルの安全チェック（Git hooks）

初回のみ `lefthook install` で hooks を有効化する。**ホスト側のみ**で動作し、テンプレートイメージには含めない。

```bat
winget install --exact --id evilmartians.lefthook --accept-package-agreements
winget install --exact --id Betterleaks.Betterleaks --accept-package-agreements
lefthook install
```

- **pre-commit**
  - `betterleaks git --staged` … ステージ済みのシークレット漏洩を検査（Gitleaks 作者による後継スキャナ）。
  - `node tools/sisakulint.mjs` … `.github/workflows/**` を変更したときだけ GitHub Actions のセキュリティ解析（OWASP CI/CD Top 10・SAST・taint 解析）。
- **pre-push**
  - `betterleaks git` … リポジトリ全履歴を検査。

### sisakulint は repo 限定で導入

`node tools/sisakulint.mjs` は初回実行時に**`.tools/`（gitignore）内だけ**に導入する。グローバルには何も入れない。

- Go が無ければポータブル Go（`tools/golang.version`）を `.tools/go` へダウンロード
- `go install .../sisakulint@v<tools/sisakulint.version>` で `.tools/bin` にビルド
- バージョンは Renovate が更新（`tools/sisakulint.version` / `tools/golang.version`）
- 手動実行: `node tools/sisakulint.mjs -fix dry-run`（差分確認）/ `-fix on`（自動修正）/ `-init`（設定生成）
- ignore ポリシー: `tools/sisakulint.ignore`

## CI / セキュリティ / 依存更新

- `.github/workflows/build.yml` … opencode / codex を **matrix で並列**ビルド。集約ジョブ `build` が必須チェック。PR はビルドのみ、main はビルド＋ghcr push（**provenance + SBOM** 付き）
- `.github/workflows/sisakulint.yml` … GH Actions の SAST（`fail-on: high`）。SARIF は自前生成し `codeql-action` v4 で Code Scanning へ
- `.github/workflows/nix.yml` … `flake.nix` の devShell を検証
- `.github/workflows/pstack-update.yml` … 毎日 03:17 UTC に本家 `cursor/plugins/pstack` の更新を検知し PR を作成
- `renovate.json` … Dependabot alerts 連携（`vulnerabilityAlerts`）／**非メジャーを1PRに集約**／Actions を `GitHub Actions` でまとめ／**リリース後3日待ってから PR**（`minimumReleaseAge: "3 days"` + `internalChecksFilter: strict`）。security 修正のみ即時
- base イメージは **digest ピン**。pstack / base / npm / sisakulint / Go / waza / ax を追従
- 署名: コミットは **SSH 署名**（`gpg.format=ssh`）。GitHub の Signing Key に `id_ed25519.pub` を登録すると Verified 表示

## Nix（依存管理）

`flake.nix` でこのリポジトリの依存を管理する。

- devShell: `nodejs_24` / `go` / `git` / `gh` / `curl` / `jq` / `lefthook` / `betterleaks`（Linux は `docker-client`）
- `bundle`（イメージに入れる CLI 一式）: nixpkgs の `uv` `mise` `gh` `apm-cli` `pnpm` `agent-browser` ほか ＋ 自前導出 `waza` `ax` `sisakulint` `mo`
- `nix build .#bundle`（個別は `.#waza` `.#ax` `.#sisakulint`）
- ※ npm 固定版の例外: `@opencode/cli`(v2) / `cf`(Cloudflare 公式) / `difit`（npm パッケージが自己完結しないため）
- `.github/workflows/nix.yml` が検証、`.github/workflows/nix-lock.yml` が `flake.lock` を生成（PR）
- `.github/workflows/nix-tools-update.yml` が `flake.nix` の固定 CLI（waza/ax/sisakulint）の version＋hash を更新（PR）
- Renovate が `flake.lock`（nixpkgs）を追従。固定 CLI のハッシュは Renovate では再計算できないため専用ワークフローが担当

方針と **sbx への影響**は [`docs/nix.md`](docs/nix.md) を参照。
※ Windows は Nix 非対応（WSL 等が必要）。開発機では `tools/*.version` ＋ winget を併用。

## 更新

- 本家 pstack 更新: `sbx env run ...`（initialize のビルド内で再取得・再変換）
- explainer / yomiyasu / agent-browser / apm-usage: 再ビルドで `main` を再取得
- waza / ax: Dockerfile の `ARG WAZA_VERSION` / `ARG AX_VERSION` で固定（Renovate が更新。waza は CI のレート制限回避のためリリース資産を直接取得）
- `pstack-opencode` はビルド内生成のため `apm update` の対象外（再ビルドで更新）

## 未検証・注意

- `lifecycle.initialize` の host コマンドが Windows でどの shell を使うか（`docker`/`sbx` だけのコマンドにしているので shell 非依存の想定）。
- Nix single-user がコンテナ内で動作するかは実機確認が必要。
- 本家 poteto-mode は Cursor 前提部分があり、OpenCode でマルチモデル連携の挙動は未検証。
- pstack は OpenCode のみ（codex には未導入）。
