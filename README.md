# resource-bridge-cli

リリースの準備・公開は [リリース手順](docs/release-automation.md) を参照してください。

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
| `--jsonl` / `--until <pointer>=<json>` | 更新を1行1JSONで逐次出力し、条件一致まで終了しない。[逐次出力](#逐次出力--jsonl)を参照 |
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
| `UNTIL_REQUIRED` / `INVALID_ARGS` | `--jsonl` で `--until` が未指定／`--until` の書式不正・`--json` との併用・`--jsonl` なしの `--until`（いずれも通信前に失敗） |
| `INTERNAL_ERROR` | 引数不正、または上記に分類されない失敗 |

## 逐次出力（`--jsonl`）

途中の更新を呼び出し元へ都度渡したい場合に使うopt-inの出力です。既存の `--json`（終了時の単一JSON）と行形式は変わりません。

```bash
resource-bridge-cli   --url https://gateway.example/mcp/review-raven   --uri review-raven://requests/<cycleId>   --jsonl --until /terminal=true   --timeout-ms 1200000
```

stdoutに1行1JSONを、受信の都度flushして出力します。診断・警告はstderr。各行は `schemaVersion: 1` を持ち、既存の版の項目は変更しません。

| `type` | 出力されるとき | 主な項目 |
|---|---|---|
| `ack` | listenのackとURI受理を検証した直後 | `resourceUri`、`honoredUris` |
| `snapshot` | ack後の現在値read（`source: "post-listen"`）と、通知を受けた後のread（`"notification"`）ごと | `notificationUri`、`text`（本文そのまま）、`json`（JSONとして解釈できなければnull）、`matched` |
| `end` | 終了時（1回） | `reason`（`until-matched` / `error`）、`closeReason`、`errorCode`、`notificationCount`、`recommendedNextAction` |

- **終了条件** `--until <JSON Pointer>=<JSON値>` は `--jsonl` で必須です。`json` の [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) Pointerの値がJSON値と一致（深い等価）したsnapshotで終了します。文字列は `--until /kind=approved` のように引用します。最初の `=` でPointerと値を分けます。本文がJSONでない・Pointerが存在しない場合は不一致として待機を続けます。CLIはPR・HEAD・Verdictを解釈せず、`--until` の機械的な一致だけを見ます。
- **終了コード** 条件一致は0、それ以外（timeout・切断・引数不正・通信失敗）は1。失敗時も `end` 行（`reason: "error"`、`errorCode`）を出力します。`--timeout-ms` は接続・一覧確認・各readを含む全体の予算で、予算を超えたreadは一致する値であっても成功にせず `NOTIFICATION_TIMEOUT` で終了します。timeoutや切断を成功扱いにせず、再enqueueなどの自動復旧もしません。
- **既完了** listen前に結果が確定していても、ack後の現在値readで検出して即終了します。通知の取りこぼしは履歴再生ではなく、最新のsnapshotで補います。
- **Git Bash** 先頭の `/` が引数のパス変換で書き換わると `INVALID_ARGS` で失敗します。`MSYS_NO_PATHCONV=1` を設定してください。

```jsonl
{"schemaVersion":1,"type":"ack","resourceUri":"test://review/progress","honoredUris":["test://review/progress"]}
{"schemaVersion":1,"type":"snapshot","source":"post-listen","notificationUri":null,"text":"{\"stage\":\"ciPending\",\"terminal\":false}","json":{"stage":"ciPending","terminal":false},"matched":false}
{"schemaVersion":1,"type":"snapshot","source":"notification","notificationUri":"test://review/progress","text":"{\"stage\":\"reviewed\",\"terminal\":true}","json":{"stage":"reviewed","terminal":true},"matched":true}
{"schemaVersion":1,"type":"end","reason":"until-matched","closeReason":"local","errorCode":null,"notificationCount":2,"recommendedNextAction":null}
```

fixtureの `test://review/progress` は、`updateDelaySeconds` ごとに4段階（`ciPending` → `waiting` → `running` → `reviewed`、最後だけ `terminal: true`）へ進みます。

## 同じ PC のレビュー進捗の監視（`watch-review-status`）

Squirrel Notifier（v0.16.0 以降）が公開する `review-status.json`（公開契約 `schemaVersion: 1`）を監視し、**起動前から実行中・終了までの進捗**を、状態が変わるたびに 1 行ずつ出力します。MCP サーバーには接続せず、認証も要りません（同じ PC のファイルを読むだけです）。設計は [review-raven の設計メモ](https://github.com/scottlz0310/review-raven/blob/main/docs/design/review-progress-local-status.md) を参照してください。

```bash
resource-bridge-cli watch-review-status --key scottlz0310/review-raven#158 --after "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)"
```

- `--key <owner/repo#N>` 対象 PR（大文字小文字は区別しません）。
- `--after <ISO8601>` `enqueue_review` の**直前**の時刻（UTC、末尾 `Z`）。これより後に受信した項目だけが今回の round です。前の round の `finished` は拾いません。**小数秒まで保持して比較する**ので、`date -u +%Y-%m-%dT%H:%M:%S.%NZ` のように小数秒つきで渡してください（秒精度でも動きますが、同じ秒に起きた enqueue と受信の前後は、小数秒がないと判定できません）。
- `--file <path>` 既定は `%LocalAppData%/SquirrelNotifier/review-status.json`（`LOCALAPPDATA` が無い環境では必須）。
- `--interval-ms`（1000）、`--heartbeat-ms`（300000）、`--stale-ms`（180000）、`--not-received-ms`（120000）、`--timeout-ms`（1200000）。**このモードの `--timeout-ms` は他のモードと違い、既定が 20 分**で、`MCP_PROBE_TIMEOUT_MS` は読みません。`--timeout-ms` は**全体の期限**で、ファイルの読み取り・再試行の待ち・`--interval-ms` の待ちを含みます。読み取りが止まっても期限で `timeout` を出し、期限を過ぎてから届いた結果（`finished` を含む）は処理しません。

stdout に 1 行 1 JSON を出します（`schemaVersion: 1`、`type`、`key`、`at`）。`"terminal": true` の行が最後で、プロセスはそこで終了します。

| `type` | 出力されるとき | 主な項目 |
|---|---|---|
| `state` | 対象の `(state, holdReason, round, queuePosition)` が変わったとき | `state`（`waiting` / `running` / `finished`）、`holdReason`（`ciPending` / `busy` / `manual` / `autoPause`）、`detail`。`finished` は `outcome`・`exitCode` を持ち、terminal |
| `heartbeat` | 何も出さないまま `--heartbeat-ms` 経過したとき | `state`、`elapsedMs`。生存確認 |
| `not_received` | 対象の項目が `--not-received-ms` 経っても現れないとき（1 回） | `waitedMs`、`previousRound`（前の round が残っているとき） |
| `unobservable` | ファイルが無い／読めない／非対応の `schemaVersion`／`updatedAt` が `--stale-ms` より古い | `reason`（`no_file` / `unreadable` / `unsupported_schema` / `stale`）、`ageMs`。回復したら `recovered` |
| `action_required` | `holdReason = manual`（利用者の操作待ち） | 「レビューする」か別 CLI での起動の案内。terminal |
| `timeout` | `--timeout-ms` に達したとき | `elapsedMs`。terminal |
| `error` | 引数エラー | `errorCode`（`INVALID_ARGUMENT`）、`message`。terminal |

**終了コード:** 完了 0 / reviewer の失敗で終了 1 / 引数エラー 2 / 手動待ち 3 / タイムアウト 4。

- **`finished` は Verdict ではありません。** `outcome` / `exitCode` は reviewer の**プロセスの終了結果**です。完了の判定は、PR の Verdict コメントと `review://status` の `headSha` で行います。実際のレビューでは、Verdict の投稿のほうが `finished` より先に届きます。
- **状態の変化だけを出します。** Squirrel は 60 秒ごとに `updatedAt` だけを更新しますが、状態が同じなら行を増やしません。クライアントによっては、大きなツール出力の中間を省略するので、行は短く、少なく保っています。
- **静かなまま詰まりません。** 観測できない・未受信・手動待ち・タイムアウトは、すべて行として出ます。失敗した終了（`outcome: "failed"`）も検知できますが、原因は行からは分かりません（Squirrel のログ `%LocalAppData%/SquirrelNotifier/logs/winui3.log` を確認します）。
- Claude Code では、`Monitor` ツールでこのコマンドを動かすと、1 行が 1 通知として届きます。逐次通知を受け取れない CLI では、終了まで待って最後の行を読む使い方になります。
- 同じ PC に限られます。別の PC の Squirrel のファイルは読めません。

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
