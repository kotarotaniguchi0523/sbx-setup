# sbx 共通環境 セットアップ

Docker Sandboxes (sbx) のテンプレートと共通設定。Skill はすべて **APM（Agent Package Manager）経由**。
入口は **`sbx env`**（宣言的ファイル + 1コマンド）で、ビルドから sbx への取り込みまで一気通貫。

## 構成

```
sbx-setup/
├── sbxenv.yaml             # 入口。agent / template / lifecycle（ビルド＋取り込み）
├── docker-bake.hcl         # ローカル並列ビルド
├── flake.nix / flake.lock  # 依存を Nix 管理（CLI 一式・Node 24 LTS）
├── common-opencode/        # OpenCode 用 kit（Dockerfile 内で pstack 変換）
├── common-codex/           # Codex 用 kit
├── pstack-opencode/        # 本家 pstack を OpenCode 向けに変換する APM パッケージ
│   ├── tools/convert.mjs            # Repomix で本家を取得し .apm/ を生成
│   ├── tools/templates/AGENTS.md    # routing（opencode/AGENTS.md の元）
│   └── opencode/AGENTS.md           # routing（生成物）
├── tools/                  # sisakulint / portable Go / npm 固定 / flake 更新スクリプト
├── docs/nix.md             # Nix 方針と sbx への影響
├── .github/workflows/      # build / sisakulint / nix / nix-lock / nix-tools-update / pstack-update
├── lefthook.yml            # ローカル Git hooks（betterleaks / sisakulint）
└── renovate.json
```

- `.apm/` は**コミットする**（本家更新を PR でレビューでき、ビルドは再生成するため決定的）。
- `.tools/`、`tools/npm/**/node_modules`、`*.tar`、`.cache/` はコミットしない。

## 決定事項

| 項目 | 決定 |
|------|------|
| 入口 | `sbx env run` / `sbx env create`（`sbx-setup/sbxenv.yaml`） |
| エージェント | **OpenCode v2**（beta, `@opencode/cli`）既定 / codex（`--env-arg agent=codex`） |
| MCP | context7 のみ |
| CLI | git/gh, uv, mise, nix, cf, mo, difit, waza, apm, agent-browser, ax, node/npm（**Node 24 LTS + npm 12**） |
| 依存管理 | **Nix**（`flake.nix` の `bundle`）＋ npm のみ `package-lock`（`npm ci`） |
| Skill | すべて APM 経由（sbx skills ストアは使わない） |
| pstack | ビルド時に本家 `cursor/plugins/pstack` を OpenCode 向けに変換（opencode のみ） |
| 変換の実行 | **sbx テンプレートのビルド内**（Dockerfile 内で `node tools/convert.mjs`） |
| ビルド/取り込み | `lifecycle.initialize`（host コマンド）で buildx → image save → `sbx template load` |
| CI | **GitHub Actions**（build[必須] / sisakulint / nix / nix-lock / nix-tools-update / pstack-update cron） |
| routing | `~/.config/opencode/AGENTS.md`（常設指示） |
| サイト許可 | 現状維持 + brew/nix/cloudflare |
| 署名 | SSH 署名（`gpg.format=ssh`）。ruleset で**署名コミット必須** |
| 不採用 | PowerShell / WSL / actrun / Docker Compose |

## 利用ツール / リポジトリ

このリポジトリ（**<https://github.com/kotarotaniguchi0523/sbx-setup>**）で使うツールと配布元。

| ツール | 用途 | 提供元 | URL |
|---|---|---|---|
| Nix / nixpkgs | 依存管理 | flake | https://github.com/NixOS/nix · https://github.com/NixOS/nixpkgs |
| mise | ランタイム管理 | Nix | https://github.com/jdx/mise |
| APM (apm-cli) | Skill 管理 | Nix | https://github.com/microsoft/apm |
| mo | Markdown プレビュー | 自前導出 | https://github.com/k1LoW/mo |
| pnpm | パッケージ管理 | Nix | https://github.com/pnpm/pnpm |
| agent-browser | ブラウザ操作 | Nix | https://github.com/vercel-labs/agent-browser |
| fd | ファイル検索 | Nix | https://github.com/sharkdp/fd |
| typos | スペル検査 | Nix | https://github.com/crate-ci/typos |
| lefthook | Git hooks | Nix / host | https://github.com/evilmartians/lefthook |
| betterleaks | シークレット検査 | host（winget） | https://github.com/betterleaks/betterleaks |
| sisakulint | GH Actions SAST | 自前導出 | https://github.com/sisaku-security/sisakulint |
| waza | agent eval | 自前導出 | https://github.com/microsoft/waza |
| ax | HTTP クライアント | 自前導出 | https://github.com/yusukebe/ax |
| cf | Cloudflare CLI | npm | https://github.com/cloudflare/cf |
| difit | diff ビューア | npm | https://github.com/yoshiko-pg/difit |
| repomix | 本家 pstack 取得 | npm（npx） | https://github.com/yamadashy/repomix |
| pstack（本家） | 変換元 | 上流 | https://github.com/cursor/plugins |
| Docker Sandboxes (sbx) | 実行基盤 | Docker | https://docs.docker.com/ai/sandboxes/ |
| Renovate | 依存更新 | Mend App | https://github.com/renovatebot/renovate |

- 一覧は**このリポジトリで追加・管理しているもの**のみ。base イメージ（`docker/sandbox-templates`）が元から提供する **エージェント（opencode / codex）・Node/npm・jq / ripgrep / gh / uv・python / git / curl** は除外（base は digest ピンなので据え置き。Node/npm のみ npm 12 のため Nix で上書き）。
- **pnpm**: ワークスペースは virtiofs で symlink 不可のため、グローバル pnpm 設定（`~/.config/pnpm/config.yaml`。**pnpm のみが読む**）で `nodeLinker: hoisted` ＋ `preferSymlinkedExecutables: false` を既定にする。npm / yarn / 他言語には影響しない（プロジェクト側の `pnpm-workspace.yaml` で上書き可）。

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
sbx env run sbx-setup\sbxenv.yaml --name common-opencode --env-arg workspace=%USERPROFILE%\projects
sbx env run sbx-setup\sbxenv.yaml --name common-codex ^
  --env-arg agent=codex --env-arg template=common-codex:dev --env-arg workspace=%USERPROFILE%\projects
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
docker buildx build -f common-codex\common-codex.yaml       -t common-codex:dev    .
docker image save common-opencode:dev common-codex:dev -o "%TEMP%\templates.tar"
sbx template load "%TEMP%\templates.tar"
sbx template ls
```

> build context はリポジトリ直下（`.`）。Dockerfile が `flake.nix` / `flake.lock` を参照するため。

## サンドボックスを作る（補足）

`sbx env` 以外の入口:

```bat
REM 既にロード済みテンプレートで直接起動（ビルドしない）
sbx run --pull never -t common-opencode:dev opencode %USERPROFILE%\projects
sbx run --pull never -t common-codex:dev    codex    %USERPROFILE%\projects

REM TUI ダッシュボード（作成/一覧/attach）。テンプレート選択が出れば上記の :dev を選ぶ
sbx tui
```

## APM で導入される Skill

| パッケージ | 形 | 対象 | skills |
|---|---|---|---|
| `pstack-opencode` | ビルド内生成（ローカル `/opt`） | opencode | 38 |
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

## ネットワーク許可

サンドボックスの許可ホストは **kit 記述子**（`common-opencode/common-opencode.yaml` /
`common-codex/common-codex.yaml` の `network-policy` capability）で宣言する。
`sbxenv.yaml` には書けない（`network:` は未知フィールド）。

既定で許可:
- `github.com` / `api.github.com` / `uploads.github.com` / `raw.githubusercontent.com` / `objects.githubusercontent.com` / `codeload.github.com`（gh・APM・git）
- `api.cloudflare.com`（`cf`）
- `cache.nixos.org` / `nixos.org`（サンドボックス内の `nix`）
- `registry.npmjs.org`（npm / pnpm）

追加で許可したい場合は host 側で:

```bat
sbx policy allow network "pypi.org:443,files.pythonhosted.org:443"
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

### 個人情報の混入防止

個人情報（Windows ユーザー名・ローカルパス・個人メール等）を **commit / push でブロック**する。

- パターン: `tools/pii.txt`（1行1正規表現、`#` コメント可）
- 検査: `node tools/pii-check.mjs --staged`（pre-commit）/ `node tools/pii-check.mjs`（pre-push, 全トラック対象）
- パターン追加は `tools/pii.txt` に1行足すだけ（パターン定義ファイル自身はスキャン対象外）
- **方針**: 過去コミットの履歴に残った旧表記は**書き換えない**（コミット author メールは公開済みで匿名化にならず、履歴書き換えのコスト/リスクが利得を上回るため）。再発防止はこの hook で行う。

## CI / セキュリティ / 依存更新

- `.github/workflows/build.yml` … opencode / codex を **matrix で並列**ビルド。集約ジョブ `build` が必須チェック。PR はビルドのみ、main はビルド＋ghcr push（**provenance + SBOM** 付き）
- `.github/workflows/sisakulint.yml` … GH Actions の SAST（`fail-on: high`）。SARIF は自前生成し `codeql-action` v4 で Code Scanning へ
- `.github/workflows/nix.yml` … `flake.nix` の devShell を検証
- `.github/workflows/skills-audit.yml` … **週次（月曜 09:00 JST）＋手動**で全 skills を監査。SkillSpector は **APM の外部スキャナ統合**（`apm audit --external skillspector`。APM がオフライン＝`--no-llm` で実行し SARIF を取り込む。API キー・OpenCode ログイン・独自 baseline は**不要**）。**毎 push では走らせない**。結果は **GitHub Issue「Skill security audit」を毎回更新**（人間向け）＋ **`audit/skills` ブランチに日付付きで保存** ＋ SARIF を Code Scanning へ
- `.github/workflows/skills-verify.yml` … PR で **skill / lock の差分だけ**を APM 経由で検証し、結果を **PR にコメント**（upsert）＋ critical のみゲート
- `.github/workflows/apm-update.yml` … 週次で `apm update`（外部 skill の ref を更新）→ 差分検証 → PR
- `.github/workflows/pstack-update.yml` … 毎日 03:17 UTC に本家 `cursor/plugins/pstack` の更新を検知し PR を作成
- `renovate.json` … Dependabot alerts 連携（`vulnerabilityAlerts`）／**非メジャーを1PRに集約**／Actions を `GitHub Actions` でまとめ／**リリース後3日待ってから PR**（`minimumReleaseAge: "3 days"` + `internalChecksFilter: strict`）。security 修正のみ即時
- base イメージは **digest ピン**。pstack / base / npm / sisakulint / Go / waza / ax を追従
- 署名: コミットは **SSH 署名**（`gpg.format=ssh`）。GitHub の Signing Key に `id_ed25519.pub` を登録すると Verified 表示

## Nix（依存管理）

`flake.nix` でこのリポジトリの依存を管理する。

- devShell: `nodejs_24` / `go` / `git` / `gh` / `curl` / `jq` / `lefthook` / `betterleaks`（Linux は `docker-client`）
- `bundle`（イメージに入れる CLI 一式）: nixpkgs の `uv` `mise` `gh` `apm-cli` `pnpm` `agent-browser` ほか ＋ 自前導出 `waza` `ax` `sisakulint` `mo`
- `nix build .#bundle`（個別は `.#waza` `.#ax` `.#sisakulint`）
- ※ npm 固定版の例外: `@opencode/cli`(v2) / `cf`(Cloudflare 公式) / `difit`（npm パッケージが自己完結しないため）。`tools/npm/*/package.json` ＋ `package-lock.json` を **`npm ci`** で導入。**Node 24 LTS は Nix 管理**、**npm は `12.2.0`（最新）をレジストリから導入**（npm 12 は nixpkgs 未収録のため。Renovate が追従）
- `.github/workflows/nix.yml` が検証、`.github/workflows/nix-lock.yml` が `flake.lock` を生成（PR）
- `.github/workflows/nix-tools-update.yml` が `flake.nix` の固定 CLI（waza/ax/sisakulint）の version＋hash を更新（PR）
- Renovate が `flake.lock`（nixpkgs）を追従。固定 CLI のハッシュは Renovate では再計算できないため専用ワークフローが担当

方針と **sbx への影響**は [`docs/nix.md`](docs/nix.md) を参照。
※ Windows は Nix 非対応（WSL 等が必要）。開発機では `tools/*.version` ＋ winget を併用。

## 更新

- 本家 pstack: `pstack-update` workflow（毎日）が検知して PR。手元では `sbx env run` の再ビルドでも再変換
- 外部 skill（explainer / yomiyasu / agent-browser / ax / waza / apm-usage）: **`apm-update` workflow（週次）が `apm update` で `pstack-opencode/apm.lock.yaml` を更新して PR**（lock で exact SHA ＋ content_hash 固定）
- Nix のツール（uv / mise / gh / apm-cli / mo / pnpm / agent-browser ほか）: `flake.lock`（Renovate が nixpkgs を追従）
- 自前固定 CLI（waza / ax / sisakulint）: `nix-tools-update` workflow が version＋hash を更新（PR）
- npm の例外（`@opencode/cli` / cf / difit）: `tools/npm/*/package-lock.json` を Renovate が更新
- base イメージ（`docker/sandbox-templates`）: digest ピンを Renovate が更新
- ローカル pstack（パス依存）は `apm update` の対象外（`pstack-update` が再変換して PR）

## 未検証・注意

- Nix 由来ツールとサンドボックス内 `nix` の動作はローカル/CI で確認済み（単一ユーザー install は `/nix` を agent 所有にして解決）。
- 本家 poteto-mode は Cursor 前提部分があり、OpenCode でマルチモデル連携の挙動は未検証。
- pstack は OpenCode のみ（codex には未導入）。
- 自動化 PR（`pstack-update` / `nix-lock` / `nix-tools-update`）はコミット未署名。ruleset の `required_signatures` 下で squash マージできるか未検証（問題時は GPG/SSH 署名に対応）。
