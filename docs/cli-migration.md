# resource-bridge-cli への移行

公開パッケージ・実行名を `mcp-resource-subscriber` から `resource-bridge-cli` に変更する。GitHub repo名は維持する。製品はMCP resourceの購読・結果配送を行うCLIクライアントであり、MCPサーバーではない。

## 名称と公開物

| 対象 | 新仕様 |
|---|---|
| npm package / bin / help / version | `resource-bridge-cli` |
| tarball | `resource-bridge-cli-<version>.tgz`（`pnpm pack`） |
| 配布範囲 | `dist/src/client/`、README、LICENSE |
| SDK client名 / 新規OAuth DCR client名 | `resource-bridge-cli` |
| module / 関数 / 型 | `subscriptionClient.js` / `runResourceSubscription` / `ResourceSubscriptionOptions` / `ResourceSubscriptionResult` |
| GitHub repo / token cache / 環境変数 | 既存のまま |

旧名のbinやmoduleの互換wrapperは追加しない。新しいpackageを使用するプログラムは新module pathへ移行し、`uri` を明示する。旧公開packageは切替検証が終わるまで維持する。

2026-10-07の調査ではnpmの同名metadataは404、GitHub repository名検索・code検索に同名の結果はなく、devホストのPATHにも同名コマンドはない。類似語のAzure Arc resource bridgeなどは存在する。名称予約・公開権限の保証ではないため、公開直前にregistryと公開権限を再確認する。

## 棚卸しと削除の根拠

棚卸し対象はこのrepoのentry・scripts・CI・test・文書、およびローカルのMcp-Docker（`a2b2d5ee6b6448a34346269703a45eef7273a644`）の現行skillとSquirrel（`5922927792ec89689a01af35adaeb4632b41c831`）の実装・テスト。未知の外部利用者の不使用を保証するものではない。

| 対象 | 根拠と扱い |
|---|---|
| `scripts/subscribe-client.ts` / `probe:subscribe` | 別の手動probe経路。package.json・README・AGENTS.md・旧skillの入口探索説明にのみ参照があり、CI/test・調査した現行利用先に実行参照はない。公開binと重複するため削除 |
| test URIの暗黙の既定値 | SquirrelとMcp-Dockerの現行skillはURIを明示している。購読CLIと運用関数の既定値を削除し、fixtureを使うテストはURIを明示 |
| `probeClient` の運用コード | 公開binから使われているので処理を残し、`subscriptionClient` へ改名 |
| capabilities / resource-found / 非JSON出力 | repo内テスト・出力契約に参照があり、全外部利用先の不使用は確認できないため維持 |
| skip-list / logout / 認証 | Squirrelの設定・テストまたは既存の認証運用に必要なので維持 |
| `src/server/` / Docker / start / dev | 統合・CLIテストとCIが利用。テストfixtureとして維持し、製品案内から区別 |
| SDK/runtime/依存 | 現行の購読・認証・fixtureで使用するため維持。lockfileやtoolchainを下げない |
| 互換性結果・旧検証ガイド・旧レビューskill | 初期検証の履歴として維持。現行のレビュー運用指示として使用しない |

## 呼び出し契約

- 購読URIは `--uri` または `MCP_PROBE_URI` で明示する。未指定・空文字は `RESOURCE_URI_REQUIRED`、終了コード1。既存JSONの `resourceUri` はstringのまま、未指定なら空文字を返す。
- `call` / login / logout / help / version は購読URIを要求しない。
- JSON、非JSON出力、終了コード、timeout、protocol固定、ack/URI受理、通知race、切断・認証失敗の扱いを維持する。
- HEAD/最終statusの確認は呼び出し元が行う。CLIの正常終了だけでレビュー完了・approveとは判断しない。
- token cacheのOS state dir・SQLite形式・origin単位の識別・client_id・refresh/rotation・`MCP_PROBE_*` を維持する。改名を理由にキャッシュや実データを移動・削除しない。

## 公開・配布・切替順

1. このrepoでbuild/check/typecheck/test:coverage/Dockerとtarballを検証し、独立レビューを受ける。マージと公開は別の操作として扱う。
2. 公開前に新npm名の利用可否、初回公開権限、Trusted Publishing設定を確認する。旧package向けOIDC設定が新packageにも使えるとは扱わない。公開するversion・tagはリリース工程で決める。
3. 新CLIを先に公開・配布して、help/version・購読/call・既存キャッシュの継続利用を確認する。未公開時の新名称 `pnpm dlx` は使わず、local build/tarballを使う。
4. Mcp-Dockerへ新名称・変更しないJSON/認証契約とURI必須化を渡す。相手repoがskill/references/catalog/revisionを更新し、リリース・各CLIへの再配布を行う。
5. Squirrelへ同じ契約を渡す。相手repoが既定コマンド・version認識・表示/案内・fixtureを更新する。保存済みのユーザー指定コマンドパスは無断で上書きしない。
6. 配布後に利用者の指示文書・設定を切り替える。旧CLIで動くレビュー基盤を移行中も保持する。
7. 利用対象エージェントを明記して、シェル起動から同じLLMセッションのJSON受信、要求URI/対象PR/ack/最終status/固定HEAD/current HEAD照合、後続thread取得まで検証する。

証跡にはCLI版・skill revision・エージェント/モデル・対象HEAD・経路・成否を残す。local fixtureの成功だけで実運用配送の成功とは扱わない。未検証のエージェントは未検証と記載する。

## 切り戻しと完了条件

新CLIの通信・認証・結果配送が失敗した場合は、利用先のコマンド設定・skillを旧配布物へ戻す。共通cacheを維持するため、切り戻しに伴うDB初期化は不要。旧packageの削除・廃止は全利用先の切替検証と利用者の許可後に行う。

このrepoの実装マージは第一段階の一部である。新CLIの公開、利用先更新・再配布、実エージェントの結果受信を確認してから、利用者と第一段階の成功を判断する。内包化・MCPサーバー化・CLI廃止は必須の後続作業にしない。
