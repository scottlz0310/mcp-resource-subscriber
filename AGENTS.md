# AGENTS.md

## プロジェクトの目的

`resource-bridge-cli` は、MCP resourceを購読して結果を同じLLMセッションへ返すCLIクライアント。公開binは `dist/src/client/cli.js`。シェルで実行し、MCPサーバーとして登録・探索しない。GitHub repo名は `mcp-resource-subscriber` を維持する。

- 購読: `subscriptions/listen` → ack/URI受理検証 → 更新通知 → 再read → stream close。既完了raceも扱う。
- `call`: 単発 `tools/call`。enqueueなどに使い、購読と同じ認証を再利用する。
- 認証: `--login` / `--logout`、SQLiteキャッシュ、期限切れtokenのrefresh/rotation。
- `src/server/`: 統合テスト用fixture。製品のMCPサーバー機能ではない。

protocolは `2026-07-28` に固定し、legacyへフォールバックしない。URIは `--uri` または `MCP_PROBE_URI` で明示し、未指定は `RESOURCE_URI_REQUIRED`。旧手動probeスクリプトは廃止した。

## 必須コマンド

現行 `package.json` とCIを正本とする。Node `>=26.10.0`、`pnpm@12.6.0`。lockfileは `pnpm-lock.yaml` のみ。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm run test:coverage
pnpm run typecheck
pnpm test
pnpm run format
pnpm pack
# fixtureの手動確認
pnpm run dev
pnpm run start
node dist/src/client/cli.js --url http://127.0.0.1:8089/mcp --uri test://review/status --json
docker compose up --build
```

CI順序は install → check → build → test:coverage → docker build。Publishの検証は install → build → typecheck → test。`dist/**` はVitestの収集から除外し、build後の二重実行を避ける。既存のpnpm/Biome/tsc/Vitest/lefthookを維持する。

## コードと契約

- `src/client/cli.ts`: bin、引数・認証・JSON/行形式・終了コード。
- `subscriptionClient.ts`: `runResourceSubscription`、`ResourceSubscriptionOptions` / `ResourceSubscriptionResult`。`uri` は必須。
- `callClient.ts` / `callJsonOutput.ts`: 単発tool呼び出しと出力。
- `jsonOutput.ts` / `networkErrorClassification.ts`: 購読出力と通信エラー分類。
- `protocolNegotiation.ts`: protocol固定、negotiation失敗の正規化。
- `auth/tokenStore.ts` / `oauthClient.ts` / `gatewayAuth.ts`: キャッシュ・OAuth・refresh制御。

相対importは `.js` 拡張子。`moduleResolution: NodeNext`、`rootDir: .` で、src/testを同じ構造のままdistへ出力する。配布はclientだけ。`runResourceSubscription` を利用するプログラムは新module pathと明示URIへ移行する。恒久的な旧名wrapperは追加しない。

JSON、終了コード、認証キャッシュ・環境変数は利用先の契約。購読は成功0/失敗1、callは成功0/toolエラー1/認証2/通信・引数3。`call` はtransport close後に `process.exitCode` で自然終了する。強制 `process.exit()` はWindowsのlibuv終了raceを起こすため使用しない。

完了確認は呼び出し元が担当する。要求URI・対象PR・`listenAcknowledged`・`honoredUris`・最終status・固定HEAD/result headSha/current HEADを照合し、完了後もthreadを取得する。timeout・URI/HEAD不一致を完了扱いにしない。CLIは独立reviewerを起動せず、LLMの反復ポーリングへ戻さない。

## 認証の維持

明示 `--auth-token` / `MCP_PROBE_AUTH_TOKEN` が最優先。次にURL origin単位のSQLiteキャッシュ。購読・callは未作成のキャッシュを作らず、作成はloginのみ。logoutは指定originの行を削除し、未作成ならno-op。

改名後も `mcp-resource-subscriber/tokens.db` のOS state dir、形式、client_id、`MCP_PROBE_*` を維持する。改名だけでキャッシュを複製・削除・初期化しない。refresh/rotationはcross-processロックで排他する。ロック待機・discovery・refreshを同じtimeout予算に含め、SQLite `busy_timeout` も上限に合わせる。

## fixtureとテスト

`createMcpHttpApp()` はアプリスコープに状態とevent busを持つ。McpServerはrequestごとに作り直される。listen streamが0→1で更新タイマーを開始し、streamがないときのreadで状態をversion 1へ戻す。readを更新タイマーの起点にするとlisten前に通知が失われるので変更しない。

handlerの `notify.resourceUpdated()` が通知を配信する。resource handlerは `McpServer.server.setRequestHandler()`、toolは `McpServer.registerTool()` を使う。

統合/CLIテストは実HTTPとSDKを使い、ポート0・`updateDelaySeconds: 0.05`、afterEachでcloseする。認証はin-process mock、token storeは一時DBに分離する。CLIサブプロセスに開発者のtoken・URL・URI・timeout設定を継承させない。

## 文書と移行

[README](README.md)、[名称変更・削除一覧と移行手順](docs/cli-migration.md)、[protocol移行記録](docs/protocol-migration.md)を参照する。results・旧検証ガイド・旧skillテンプレートは履歴として維持し、現行運用の入口にしない。Mcp-Dockerのskill配布先やSquirrelのユーザー設定はこのrepoから直接変更しない。

commit前にCHANGELOG.mdとtasks.mdを更新する。PRは同じ変更に必要な実装・テスト・設定・文書をまとめる。1000行超は分割検討の目安であり、行数だけで機能を分割しない。

## シークレットと証跡

token、Authorization、cookie、session、refresh token、client secret、秘密鍵をログ・GitHub投稿・証跡へ出さない。環境変数の生dumpを載せない。公開時は `<redacted>` / `Bearer <redacted>` を使い、URL・URI・route・ack・notification・error-codeなどのprotocol事実だけを残す。漏洩した秘密は公開文の編集だけで済ませず失効・rotationする。
