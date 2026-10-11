# Nix 化の方針と sbx への影響

## 目的

- 依存を「実行時に最新を取得（`curl | bash` / `brew` / `npm -g`）」から
  「**固定・ハッシュ検証済み**」へ移す（サプライチェーン対策）。
- dev / CI / イメージで**同一の依存**を使い、再現性を持たせる。

## いま入っているもの

- `flake.nix`
  - devShell（nixpkgs）: `nodejs_24` `go` `git` `gh` `curl` `jq` `lefthook` `betterleaks`（Linux は `docker-client`）
  - `bundle`（サンドボックスイメージに入れる CLI 一式）:
    - nixpkgs: `uv` `mise` `gh` `apm-cli`(microsoft/apm) `pnpm` `agent-browser` `jq` `ripgrep` `fd` `typos` `lefthook` `betterleaks`
    - 自前導出（nixpkgs に無い）: `waza` `ax` `sisakulint` `mo`(k1LoW)
      - リリース資産を `sha256` 付き `fetchurl` で取得
  - 例外（**npm 固定版**）: `@opencode/cli`(v2) / `cf`(Cloudflare 公式) / `difit`
    - これらの npm パッケージは自己完結せず実行時依存（`minisearch`/`commander` 等）を import するため tarball ラップでは動作せず、Nix 化しない（nixpkgs の `opencode` は別プロジェクト v1）
    - **完全固定**は `tools/npm/cli`（cf, difit）と `tools/npm/opencode`（@opencode/cli）の `package.json` ＋ `package-lock.json` を **`npm ci`**（integrity 付き）で導入。Renovate が lock ごと更新
  - イメージは `nix build .#bundle` の**クロージャを tar 化して `COPY`** し、`/usr/local/bin` にリンク（`npm -g` / `brew` / `curl\|bash` を撤去）
- `.github/workflows/nix.yml` … flake の検証＋パッケージの実ビルド
- `.github/workflows/nix-lock.yml` … `flake.lock`（nixpkgs のピン）を生成して PR
- `.github/workflows/nix-tools-update.yml`（＋`tools/nix-tools-update.mjs`）… `flake.nix` の waza / ax / sisakulint の version＋hash を更新して PR

### 依存更新の分担

| 対象 | 担当 |
|---|---|
| `flake.lock`（nixpkgs） | **Renovate**（nix manager）＋ `nix-lock` |
| `flake.nix` の固定 CLI（waza / ax / sisakulint） | **`nix-tools-update`**（Renovate は固定出力ハッシュを再計算できないため） |
| `tools/*.version` / Dockerfile の `ARG` | **Renovate** |

## セキュリティ上の線引き

| 対象 | Nix |
|---|---|
| ビルド/開発ツールチェーン | ✅ |
| nixpkgs に無い CLI（固定） | ✅ |
| イメージの中身（発展） | ✅（`nix build` → `COPY`） |
| **秘密（トークン・鍵）** | ❌ store は world-readable |
| 実行時状態・ワークスペース | ❌ |
| sbx のオーケストレーション | ❌ Docker/ランタイムの領分 |
| Windows ホスト | ❌（Nix 非対応／WSL 必須） |

## sbx 実装がどう変わるか

### 変わらないもの

- 入口 `sbx env`（`sbxenv.yaml`）と `lifecycle.initialize` の流れ。
- skills の APM 導入、`~/.config/opencode/AGENTS.md` のルーティング。
- `sbx template load` の手順（tar を読み込む点）。
- 秘密は `sbx secret`（**Nix には置かない**）。

### 変わるもの（段階的）

1. **kit Dockerfile の中身**
   - before: `curl | bash`（uv / mise / ax / waza）や `brew` / `npm -g` で実行時取得。
   - after: 多段ビルド `FROM nixos/nix AS nix` で `nix build .#waza .#ax .#sisakulint` し、
     `COPY --from=nix /nix/store/.../bin/... /usr/local/bin/` で最終イメージへ取り込む。
     `uv` / `mise` は nixpkgs（`pkgs.uv` / `pkgs.mise`）へ寄せる。
2. base イメージは **digest ピン**（済）。その上に Nix 由来の固定物を重ねる。
3. **Renovate の追従対象に `flake.lock`（nixpkgs）が加わる**（3日待ちも適用）。
4. **CI**: `build` は「Nix ビルド → イメージ取り込み」に変わる。`nix.yml` で先に検証。
5. ビルド時間/キャッシュ: Nix store キャッシュ（Cachix 等）を併用すると速い。

### 注意

- **Nix store は world-readable** → 秘密を絶対に入れない。
- イメージサイズ（closure）が増えうる。
- Windows 開発機では Nix 不可 → `tools/*.version` ＋ winget を併用（現状維持）。

## tynix（検討 → 見送り）

Nix の段階的型システム [tynix](https://github.com/ubugeeei-prod/tynix)（`ubugeeei-prod/tynix`, v2.0.0）を評価した。

- できること: `.tynix`（型注釈→`.nix` にコンパイル）、`.d.tynix`（既存 `.nix` への ambient 宣言）、`check` / `check-project` / `compile` / `lsp` / `doctor` など。
  実測では **`tynix check flake.nix` がプレーンな `.nix` も解析でき**、`pick` の `table.${system}` 動的アクセスで型が消える箇所を `TC0009` で指摘した（タイポ検出 `TC0009` や型不一致 `TC0013` も的確）。
- **見送り理由**:
  1. このリポジトリの Nix 面は `flake.nix` 1枚で小さく、型破綻リスクが低い。
  2. **Windows バイナリが無い**（開発機で動かせず Docker/WSL/CI 頼み）。
  3. v2.0.0 で挙動にムラ（`prefix ++ "/"` に `TC0020` を出すなど）。
  4. **セキュリティ/サプライチェーンには寄与しない**（正しさ・DX の道具で、Nix 化の主目的とは別軸）。
- **再評価条件**: Nix コードが増えたとき（段階2以降で `.nix`/`.tynix` が複数になる、overlay が肥大化する等）。
  導入する場合も **非必須の情報ジョブ**から始める。

## 移行ステップ

1. （このPR）flake にツールを載せ、CI で実ビルド検証、`flake.lock` 生成。
2. kit Dockerfile を Nix ビルド段に置換（まず waza / ax）。
3. `uv` / `mise` / `brew` / `npm -g` を Nix へ。
4. 余力で sbx イメージ自体を `dockerTools` 化（完全再現ビルド）。
