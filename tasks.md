# 作業タスク

## CLI名称変更と初期probe入口の整理（Issue #209）

- [x] `resource-bridge-cli` の名称・重複調査と変更範囲を合意する
- [x] package/bin/help/client識別名・文書を揃える
- [x] 重複する手動probe入口を削除し、購読URIを明示必須にする
- [x] JSON・認証・非JSON・テストfixtureの契約を維持する
- [x] CI相当の品質ゲートと配布tarballを検証する
- [x] 独立レビュー・同じHEADのCIを確認してマージする（PR #210）
- [x] 新CLIの公開・利用先の切替（Mcp-Docker / Squirrel / 共通指示）を完了
- [x] 実PRによるレビューサイクル（独立reviewer起動・同一セッション結果受信）の検証（PR #213）

## Dockerfile の Corepack 移行（PR #212 CI 失敗の恒久対応）

- [x] 原因調査: Alpine コンテナ内の古い pnpm 11 と package.json の pnpm 12.9.1 の非互換性（ELF バイナリの誤解釈 SyntaxError）を特定
- [x] Dockerfile を Corepack パターンに刷新し、packageManager への一本化を実施
- [ ] 独立レビュー・同じHEADのCIを確認してマージする

## 逐次購読出力 `--jsonl` / `--until`（#225、review-raven#144 R2）

- [x] オプション名（`--jsonl`）と `--until` 必須の方針を利用者と合意する
- [x] `--jsonl` と `--until` の実装、4段階fixture、実HTTP/サブプロセスでのテスト（途中行の先着・terminalまでの継続・既完了・切断・timeout）
- [x] README・移行文書・CHANGELOGを更新し、既存の `--json`・`call`・認証・終了コードの維持を確認する
- [ ] 独立レビュー・同じHEADのCIを確認してマージする
- [ ] 公開（npm）と呼び出し側（Mcp-Docker skill / Squirrel）の利用切替は別Issue・別許可（Mcp-Docker#393）

## 進捗監視 `watch-review-status`（#228、review-raven#144 案C）

- [x] 設計メモの合意（review-raven#158）と、bash+jq の試作を実レビューroundで確認する
- [x] 時刻比較（小数秒を保持）・対象の選択・状態機械を、DIとパラメータ化テストで実装する
- [x] 実ファイルを使うCLIテスト（遷移・終了コード・引数エラー）と、README・CHANGELOGを更新する
- [ ] 独立レビュー・同じHEADのCIを確認してマージする
- [ ] 公開（従前の作法で版を上げる）と、reviewed側skill Phase W の見直し（Mcp-Docker、別PR）
