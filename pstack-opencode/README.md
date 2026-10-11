# pstack-opencode

[poteto（Lauren Tan）の pstack](https://github.com/cursor/plugins/tree/main/pstack)
を **OpenCode 向けに自動変換した APM パッケージ**。

本家は Cursor / Claude Code 前提で、frontmatter 名が不正（`Poteto Mode` など）で
あり、ツール名・サブエージェント・モデル名も別物。このパッケージは本家を取り込み、
OpenCode の規約に合わせて正規化したうえで配布する。

## 構成

```
pstack-opencode/
├── apm.yml                  # targets: [opencode]
├── SOURCE.json              # 変換元と生成物の一覧
├── .apm/                    # 生成物（ここは手で編集しない）
│   ├── skills/<id>/...      # 52 skill（playbooks / references / scripts 込み）
│   └── agents/*.agent.md    # poteto-agent, comment-sicko（mode: subagent）
├── opencode/AGENTS.md       # routing 常設指示（~/.config/opencode/AGENTS.md に配置）
└── tools/
    ├── convert.mjs          # 本家 → 本パッケージの自動変換（Repomix 使用）
    └── templates/           # 変換で注入する固定ファイル
```

## 変換はビルド内で実行される

変換は **sbx のイメージビルド内**でのみ実行する。`common-opencode.dockerfile` が
ビルド中に `node tools/convert.mjs` を呼び、`.apm/` を生成してから
`apm install -g --target opencode` する。本家が更新されたら `scripts/build.cmd`
でイメージを再ビルドすれば、その中で再取得・再変換される。

1. `npx repomix --remote cursor/plugins --include "pstack/**" --style json` で本家を取得
2. 各 `SKILL.md` の frontmatter を OpenCode 向けに正規化
   - `name` をディレクトリ名（kebab）へ
   - Cursor 専用フィールド（`mode`/`icon`/`color`/`reminder`）は破棄
   - `poteto-mode` に `metadata.opencode/slash: "true"`（`/poteto-mode` 化）
   - `disable-model-invocation: true` は `metadata.opencode/autoinvoke: "false"` へ
3. `references/opencode-tools.md`（ツール/モデル対応表）を poteto-mode に注入
4. `agents/*.md` を `mode: subagent` の `.agent.md` に変換
5. `opencode/AGENTS.md`（routing）を出力

生成後は `.apm/` をコミットし、イメージを再ビルドする。

## 適用（OpenCode）

```bash
apm install -g --target opencode /path/to/pstack-opencode
cp /path/to/pstack-opencode/opencode/AGENTS.md ~/.config/opencode/AGENTS.md
```

- skills → `~/.config/opencode/skills/<id>/`
- agents → `~/.config/opencode/agents/<id>.md`
- routing → `~/.config/opencode/AGENTS.md`

## OpenCode での対応関係

| 本家（Cursor/Claude） | OpenCode |
|---|---|
| Read / Write / Edit | `read` / `write` / `edit`（+`patch`） |
| Bash | `shell` |
| Grep / Glob | `grep` / `glob` |
| Task / Agent（サブエージェント） | `subagent` ツール |
| AskUserQuestion | `question` |
| Skill ツール | `skill` ツール |
| TodoWrite など | 専用ツール無し → `todo.md` 運用 |
| `opus` / `grok` など | 各自の `provider/model` |
| `/loop` | 無し → 手動再実行 |

詳細は `.apm/skills/poteto-mode/references/opencode-tools.md` を参照。

## 既知の注意

- 本家 poteto-mode は subagent / `/loop` / custom mode を前提とする部分があり、
  OpenCode では完全一致では動かない。変換で読み替えるが、マルチモデル連携の
  挙動は未検証。
- `apm compile -g` は instruction プリミティブを二重出力する挙動があるため、
  routing は instruction ではなく `opencode/AGENTS.md` を直接配置している。
