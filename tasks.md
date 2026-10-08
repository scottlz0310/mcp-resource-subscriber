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


