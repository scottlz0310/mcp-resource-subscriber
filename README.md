# resource-bridge-cli

MCP resource の購読・結果配送と、単発の `tools/call` を行う CLI クライアントです。シェルから実行し、stdout の結果を呼び出したエージェントの同じセッションへ返します。

**MCP protocol revision は `2026-07-28` に固定**しています。`subscriptions/listen` を使用し、legacy protocol へフォールバックしません。対応していないサーバーは `PROTOCOL_UNSUPPORTED` で失敗します。

GitHub repo名は `mcp-resource-subscriber` のままです。旧CLIからの変更範囲と切替順は [移行手順](docs/cli-migration.md)を参照してください。新名称のパッケージは公開後に以下のコマンドで利用できます。未公開版はローカルビルドで検証してください。

## インストールと更新

```bash
pnpm dlx resource-bridge-cli --url <mcp-server-url> --uri <resource-uri> --json

# 常設する場合。更新時も同じコマンドを使用する
pnpm add --global resource-bridge-cli
resource-bridge-cli --version
```

Node `>=26.10.0` が必要です。このrepoのパッケージマネージャーは `pnpm@12.6.0` です。

## 購読して結果を受け取る

```bash
resource-bridge-cli \
  --url https://gateway.example/mcp/thread-owl \
  --uri review://status/owner/repo/123 \
  --timeout-ms 1200000 \
  --json
```

CLIをMCPサーバーとして登録せず、シェルから呼び出してください。長時間待機ではシェル側の上限で打ち切られないようにプロセスを起動し、終了後のstdoutを同じセッションで受け取ります。CLIは独立reviewerを起動しません。

購読URIは `--uri` または `MCP_PROBE_URI` で明示します。テスト用の既定URIはありません。未指定・空文字は通信前に `RESOURCE_URI_REQUIRED`、終了コード1で失敗します。

| オプション | 用途・環境変数 |
|---|---|
| `--url <url>` | Streamable HTTP endpoint。`MCP_PROBE_URL` でも指定可能 |
| `--uri <uri>` | 購読URI。`MCP_PROBE_URI` でも指定可能 |
| `--timeout-ms <ms>` | タイムアウト。既定15000。`MCP_PROBE_TIMEOUT_MS` |
| `--json` | stdoutに単一JSON。診断・警告はstderr |
| `--skip-resource-list-check` | 一覧に載らない動的resourceの `resources/list` 確認を省略。`MCP_PROBE_SKIP_LIST_CHECK=true` |
| `--auth-token <tok>` | 明示Bearer token。露出を避けるため `MCP_PROBE_AUTH_TOKEN` を推奨 |
| `--login` / `--logout` | Gatewayへの対話ログイン／指定originのキャッシュ削除 |
| `--version`, `-v` / `--help`, `-h` | バージョン／使用方法の表示 |

購読は成功0、失敗1で終了します。通知を受けて再readする `subscription` と、listen後のreadで既完了を検出する `pre-completion` の両方を扱います。`recommended_next_action=POLL_AFTER` は非終端状態なので同じstreamで通知待機を続けます。

### JSON契約

```json
{
  "route": "subscription",
  "serverUrl": "https://gateway.example/mcp/thread-owl",
  "resourceUri": "review://status/owner/repo/123",
  "listenAcknowledged": true,
  "honoredUris": ["review://status/owner/repo/123"],
  "notificationReceived": true,
  "notificationCount": 1,
  "closeReason": "local",
  "errorCode": null,
  "initialText": "...",
  "finalText": "...",
  "recommendedNextAction": null
}
```

- `route`: `subscription` / `pre-completion` / `timeout` / `failed`。
- `listenAcknowledged`: listenのackを検証できたか。`honoredUris` に要求URIが含まれることも確認します。
- `closeReason`: `local` / `graceful` / `remote` / `null`。
- `notificationReceived`: `route === "subscription"` の場合にtrue。
- `initialText` / `finalText`: resource本文。JSON本文なら呼び出し元でパースします。
- `recommendedNextAction`: resourceの指示、または通信失敗時の対処案。未指定はnull。

レビュー完了待機では、要求URI・対象PR・最終 `status`（`reviewed` / `approved`）と、開始時に固定したHEAD・結果の `headSha`・現在のPR HEADの一致を呼び出し元で確認します。`timeout`・認証失敗・URI/HEAD不一致を完了扱いにしません。完了後も未解決レビューthreadを取得してください。

`--json` なしの既存の行形式も維持します。

```text
capabilities {"subscribe":true,"listChanged":false}
resource-found true
resource-uri <resource-uri>
server-url <url>
initial
<initial resource text>
route subscription
listen-acknowledged true
honored-uris ["<resource-uri>"]
notification-received true
notification-count 1
close-reason local
error-code null
notification <resource-uri>
final
<updated resource text>
phase-summary route=subscription url=<url> uri=<uri>
```

最終本文に `recommended_next_action` があればその行も出力します。失敗時のJSONも同じフィールドを持ち、`errorCode` に原因を返します。

| エラー | 原因 |
|---|---|
| `SERVER_URL_UNKNOWN` / `RESOURCE_URI_REQUIRED` | URL／購読URIの未指定 |
| `RESOURCE_NOT_FOUND` | 一覧確認で対象URIが見つからない |
| `NOTIFICATION_TIMEOUT` | 上限内に終端更新を受信できない |
| `SUBSCRIPTION_NOT_HONORED` | ackで要求URIが受理されていない |
| `SUBSCRIPTION_DISCONNECTED` / `SUBSCRIPTION_CLOSED` | streamの異常切断／サーバーによる終了 |
| `PROTOCOL_UNSUPPORTED` | 採用protocolに非対応 |
| `TLS_CERT_UNTRUSTED` | TLS証明書を信頼できない。`NODE_EXTRA_CA_CERTS` または `NODE_USE_SYSTEM_CA=1` を確認 |
| `DNS_LOOKUP_FAILED` / `CONNECTION_REFUSED` | 名前解決失敗／接続拒否 |
| `AUTH_LOGIN_REQUIRED` / `AUTH_TIMEOUT` / `AUTH_REFRESH_FAILED` | 再ログインが必要／認証処理の上限超過／一時的なrefresh失敗 |
| `INTERNAL_ERROR` | 引数不正、または上記に分類されない失敗 |

## 単発tool呼び出し

```bash
resource-bridge-cli call \
  --url https://gateway.example/mcp/thread-owl \
  --tool enqueue_review \
  --args '{"owner":"owner","repo":"repo","prNumber":123,"reason":"opened"}' \
  --json
```

`call` は `initialize` → `tools/call` → 結果出力で終了します。`--uri` は不要です。`--args` はJSON objectで、既定は `{}`。認証・URL・timeoutは購読と共通です。

| 終了コード | 意味 |
|---|---|
| 0 | 成功 |
| 1 | toolが実行され `isError: true` を返した |
| 2 | 認証失敗 |
| 3 | 通信・引数・protocol失敗。未知toolや引数のサーバー拒否は `TOOL_REQUEST_REJECTED` |

```json
{
  "serverUrl": "https://gateway.example/mcp/thread-owl",
  "tool": "enqueue_review",
  "isError": false,
  "errorCode": null,
  "content": [{"type":"text","text":"..."}],
  "recommendedNextAction": null
}
```

`content` はMCP toolのcontent配列です。通信・認証失敗時はnullです。非JSON出力は `server-url` / `tool` / `is-error` / `error-code` / `recommended-next-action` / `content` を返します。

## Gateway認証

```bash
resource-bridge-cli --login --url https://gateway.example/mcp/thread-owl
resource-bridge-cli --logout --url https://gateway.example/mcp/thread-owl
```

ログインではRFC 7591 DCRとRFC 8628 device flowを使用します。表示されたverification URIで承認するとtokenを保存します。明示tokenが最優先で、それ以外はURL origin単位のキャッシュを使用し、期限切れならrefresh・rotationを永続化します。

refresh時のロック待機・discovery・ネットワーク呼び出しも `--timeout-ms` の予算に含め、購読には認証で消費した時間を差し引いた残りを渡します。`invalid_grant` / `invalid_client` / `unauthorized_client` は再ログインを要求します。ログイン時にキャッシュ済みclientが拒否された場合は再登録します。ログイン前の購読・callはキャッシュを新規作成しません。

**名称変更後も保存先・形式・既存client_idは維持します。** tokenを複製・初期化せず、改名だけで再ログインを要求しません。既存の `MCP_PROBE_*` は引き続き使用します。

| OS | 既存の保存先 |
|---|---|
| Windows | `%LOCALAPPDATA%\mcp-resource-subscriber\tokens.db` |
| macOS | `~/Library/Application Support/mcp-resource-subscriber/tokens.db` |
| Linux | `$XDG_STATE_HOME/mcp-resource-subscriber/tokens.db`。未設定は `~/.local/state/...` |

上書きは `MCP_PROBE_TOKEN_STORE_PATH`。token・Authorization・cookieなどの生の値をログや公開証跡へ載せないでください。

## 開発とテストfixture

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm run test:coverage
pnpm run typecheck
node dist/src/client/cli.js --help
pnpm pack
```

配布対象は `dist/src/client/`・README・LICENSEです。tarball名は `resource-bridge-cli-<version>.tgz`。プログラムからは `dist/src/client/subscriptionClient.js` の `runResourceSubscription` を使用し、`uri` を明示します。

`src/server/` は統合テスト用リファレンスサーバーです。製品CLIのサーバー機能ではありません。テストはポート0のin-process HTTPサーバーを使い、通知・race・timeout・認証を検証します。手動fixtureは次のように起動できます。

```bash
pnpm run dev
# または docker compose up --build
node dist/src/client/cli.js --url http://127.0.0.1:8089/mcp --uri test://review/status --json
```

`pnpm run start` はビルド済みfixtureの起動です。CIでも `docker build .` を検証します。

| fixture環境変数 | 既定 |
|---|---|
| `MCP_TEST_PORT` / `MCP_TEST_PATH` | `8089` / `/mcp`（`/mcp` は常に登録） |
| `MCP_TEST_UPDATE_DELAY_SECONDS` | `5`。テストは `0.05` |
| `MCP_TEST_INITIAL_STATUS` / `MCP_TEST_UPDATED_STATUS` | `pending` / `reviewed` |
| `MCP_TEST_SEND_LIST_CHANGED` / `MCP_TEST_LOG_LEVEL` | `false` / `debug` |

過去の互換性検証結果は [results/](results/) に保持します。[検証ガイド](docs/verification-guide-v2.md)と [旧レビューskillテンプレート](docs/skills/pr-review-subscribe/SKILL.md)は初期検証の履歴です。現行のレビュー運用skillはMcp-Dockerが管理します。protocol移行の履歴・責務は [protocol-migration.md](docs/protocol-migration.md)を参照してください。
