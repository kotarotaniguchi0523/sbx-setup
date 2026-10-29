# CI の起動と main の保護

## 通常の PR・Renovate PR

作成者による除外は設けず、main 宛ての PR を変更範囲で検証する。

| Workflow | PR で検証する変更 | main 更新後 |
|---|---|---|
| build | 全 PR に必須チェックを返す。OpenCode / Codex / 共通入力の変更に応じて対象イメージだけビルド | 同じ入力パスの変更時だけ対象イメージを GHCR に公開 |
| nix | flake.nix、flake.lock、nix.yml | PR で検証済みのため再実行しない |
| sisakulint | Workflow、lint 設定・実装・バージョン、自動 CI 起動スクリプト | 同じパスに限定し、SARIF を公開 |
| skills-verify | APM manifest / lock、変換・vendor・スキル本体、検証コード・baseline | 再実行しない |

`build` の PR トリガーに `paths` を付けると、対象外の PR で必須チェックが永久に pending になる。軽い変更検出と集約ジョブは全 PR で実行し、重い Docker ジョブだけを絞る。

スキルは変更したスキルを検証する。lock 更新は外部スキル、manifest・変換ツール・vendor・検証基盤・baseline の変更は全スキルを再検証する。dispatch も既定は差分で、明示的な `full: true` の場合だけ全件を要求できる。比較は main との共通祖先を使い、古い更新ブランチに存在しない main の変更を今回の差分に含めない。

fork / Dependabot では書き込み権限が制限されるため PR コメントを省略する。検証とレポート artifact は実行し、検証失敗をコメント権限の問題で隠さない。SARIF の公開は main 更新後に実行する。

## 定期処理と手動実行

schedule は変更パスのフィルターと組み合わせられないため、更新・監査専用の Workflow に分ける。いずれも main で実行する。

| Workflow | 頻度（UTC） | 対象と制限 |
|---|---|---|
| pstack-update | 毎日 03:17 | SOURCE.json の上流 ref を確認し、変更時または force 指定時だけツール導入・変換・検証。PR に含めるのは `.apm` と SOURCE.json |
| apm-update | 月曜 03:30 | pstack-opencode の外部 APM 依存だけ更新。PR に含めるのは apm.yml と apm.lock.yaml |
| nix-tools-update | 月曜 03:23 | flake.nix の CLI pin だけ更新。変更時だけ Nix 導入・検証 |
| skills-audit | 月曜 00:00 | APM で固定したスキル群を専用の一時ディレクトリで全件監査。Issue・監査ブランチ・Code Scanning に報告 |
| nix-lock | 手動のみ | flake.lock だけ生成・更新。通常の定期更新は Renovate が担当 |

定期監査はスキル集合だけを対象とし、リポジトリ全体をスキャナーへ渡さない。PR の差分検証と週次の全件監査を分けることで、変更がなくても週次には固定済み依存を監査できる。

## Bot の承認不要 CI

自動更新のコミットは `create-pull-request` の `sign-commits: true` で署名する。
PR 作成直後は `tools/dispatch-pr-ci.mjs` が PR の作者、同一リポジトリ、main 宛て、既知の更新ブランチを確認してチェックを起動する。成功済み・実行中は再起動せず、失敗・キャンセル・承認待ちは再試行の対象にする。APM / pstack は OpenCode とスキル検証、Nix 更新は両イメージと flake 検証に限定する。

GitHub が `GITHUB_TOKEN` による PR の通常イベントを承認待ちにする場合も、dispatch のチェックは別に実行される。通常イベントを手動承認すると重複実行になり得る。承認待ちの表示までなくすには、PR 作成を専用 GitHub App トークンへ切り替える必要がある。

GitHub の Actions 設定は、Actions を有効にし、使用する外部 Action を許可し、`can_approve_pull_request_reviews: true`（UI の「Allow GitHub Actions to create and approve pull requests」）を有効にする。既定トークンは read、書き込み権限は必要なジョブで個別に宣言する。fork 向け承認方針はこの自動更新の承認制御とは別の設定で、所有者・同一リポジトリの Renovate PR を承認不要にするために緩める必要はない。

## ルールセット

`.github/rulesets/main.json` が main 保護の保存版。削除・force push を禁止し、PR と署名と GitHub Actions 発行の `build` を必須にする。レビュー必須人数は 0、bypass は空。個人運用の自己承認待ちを作らず、Bot にも同じチェックを要求する。

`nix` / `sisakulint` / `skills-verify` はパスによって起動しないため、現在の名前のまま必須チェックへ追加しない。追加する場合は `build` と同様に対象外にも結果を返す集約チェックを先に用意する。

2026-10-29 の確認時点では #49 / #56 の CI は成功し、両 PR の先頭コミットは unsigned、マージ状態は blocked だった。署名必須は実際のルールセットに存在していたが保存版から欠落していた。既存の未署名 PR も、新しい署名設定が main に入った後で各 updater を再実行して更新する。pstack は force 指定で再生成できる。再実行後に Verified とマージ可否を確認する。

## ローカル検証

```powershell
node --test tools/dispatch-pr-ci.test.mjs
node --check tools/skills-verify.mjs
node tools/sisakulint.mjs
```

公式仕様: [GITHUB_TOKEN のイベント制御](https://docs.github.com/en/actions/concepts/security/github_token)、[create-pull-request の署名](https://github.com/peter-evans/create-pull-request#action-inputs)、[Actions の設定](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)。
