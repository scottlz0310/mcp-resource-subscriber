# MCP Resource Subscription Compatibility Matrix

Endpoint under test:

```text
http://127.0.0.1:8089/mcp
```

Resource under test:

```text
test://review/status
```

Result levels are defined in [`docs/verification-guide.md`](../docs/verification-guide.md#result-levels).

## Summary

| Client             | Version | OS                        | Transport                     | `resources/list` | `resources/read` v1 | `resources/subscribe` | update notification path | re-read v2 | agent context v2 | Level | Notes                                                                                                                                                                         |
| ------------------ | ------- | ------------------------- | ----------------------------- | ---------------- | ------------------- | --------------------- | ------------------------ | ---------- | ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI          | 0.129.0 | Windows / PowerShell 7    | Streamable HTTP               | No               | No                  | No                    | No                       | No         | No               | 1     | Connects and initializes, but no resource methods reached the server.                                                                                                         |
| Gemini CLI         | 0.41.2  | Windows                   | Streamable HTTP               | Yes              | Yes                 | No                    | No                       | No         | No               | 3     | Connection and initial read work perfectly. Subscription is not yet supported by the CLI.                                                                                     |
| OpenCode           | 1.14.41 | Windows / PowerShell 7    | Streamable HTTP               | No               | No                  | No                    | No                       | No         | No               | 1     | Connects and initializes, but the resource-only MCP server is not exposed because OpenCode reports `Failed to get tools`.                                                     |
| GitHub Copilot CLI | 1.0.43  | Windows 11 / PowerShell 7 | Streamable HTTP (via gateway) | No               | No                  | No                    | No                       | No         | No               | 1     | Connects and initializes. Resource-only server provides no tools; no resource calls reach the server. Requires gateway routing because direct HTTP MCP servers require OAuth. |
| Claude Code        | 2.1.133 | Windows / PowerShell 7    | Streamable HTTP               | Yes              | Yes                 | No                    | No                       | No         | No               | 3     | Built-in `ListMcpResourcesTool` / `ReadMcpResourceTool` work over Streamable HTTP. Claude Code exposes no `resources/subscribe` tool to the agent.                            |
| Goose              | 1.33.1  | Windows / PowerShell 7    | Streamable HTTP               | Yes              | Yes                 | No                    | No                       | No         | No               | 3     | `extensionmanager` extension provides `list_resources` / `read_resource` but no subscribe tool.                                                                               |
| Crush              | v0.66.0 | Windows / PowerShell 7    | Streamable HTTP               | No               | No                  | No                    | No                       | No         | No               | 1     | Connects and initializes, but the resource-only MCP server is not exposed because Crush reports `Error listing tools: Method not found`.                                      |

## Codex CLI

- Date: 2026-05-08 10:20 +09:00
- Version: `codex-cli 0.129.0`
- OS / shell: Windows / PowerShell 7
- MCP configuration: Streamable HTTP server configured as `subscribe_probe` with `mcp_servers.subscribe_probe.url="http://127.0.0.1:8089/mcp"`.
- Prompt used:

```text
The configured MCP server name is subscribe_probe.
Use the subscribe_probe MCP server.
List MCP resources from subscribe_probe.
Read the resource URI test://review/status from subscribe_probe.
If subscribe_probe supports resources/subscribe, subscribe to test://review/status, wait up to 10 seconds for notifications/resources/updated, then read test://review/status again.
Report the final status, version, and message.
Do not edit files or run shell commands.
```

- Result level: `1 - connected`
- Does it call `resources/list`? No. The server log did not show `[resources/list] requested`.
- Does it call `resources/read`? No.
- Does it call `resources/subscribe`? No.
- Does it receive or react to `notifications/resources/updated`? No. The server never received `resources/subscribe`, so no resource update notification was sent.
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt:

```text
MCP resource subscribe test server listening on http://127.0.0.1:8089/mcp
[initialize] client connected
[initialize] client connected
[initialize] client connected
```

- Codex CLI command used for the explicit isolated run:

```bash
codex exec --ignore-user-config -s read-only -m gpt-5.4-mini \
  -c 'approval_policy="never"' \
  -c 'model_reasoning_effort="low"' \
  -c 'mcp_servers.subscribe_probe.url="http://127.0.0.1:8089/mcp"'
```

- Observed Codex output from the isolated run:

```text
resources/list failed: failed to get client: MCP startup failed: Mcp error: -32601: Method not found
resources/read failed: failed to get client: MCP startup failed: Mcp error: -32601: Method not found
```

- A follow-up run with the normal user config plus the same `subscribe_probe` override also initialized the server, but Codex reported that the server was not exposed through the available tool surface.

## Gemini CLI

- Date: 2026-05-08 11:25 +09:00
- Version: `0.41.2`
- OS / shell: Windows / win32
- MCP configuration: Streamable HTTP server configured in `~/.gemini/settings.json` with `mcpServers.subscribe-probe.httpUrl="http://127.0.0.1:8089/mcp"`.
- Prompt used:
```text
Check the available MCP resources.
Read test://review/status.
If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification.
After the notification, read test://review/status again.
Report the final status, version, and message.
```

- Result level: `3 - read initial resource`
- Does it call `resources/list`? Yes. `list_mcp_resources` returned the resource.
- Does it call `resources/read`? Yes. `read_mcp_resource` returned `version: 1`.
- Does it call `resources/subscribe`? No. The CLI does not provide a tool or internal mechanism for resource subscription.
- Does it receive or react to `notifications/resources/updated`? No.
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt:
```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
```

- Notes: Gemini CLI successfully discovers and reads resources over Streamable HTTP, but currently lacks the `resources/subscribe` capability.

## OpenCode

- Date: 2026-05-08 11:30 +09:00
- Version: `1.14.41`
- OS / shell: Windows / PowerShell 7
- MCP configuration: Streamable HTTP server configured in `opencode.json` with `mcp.subscribe-probe.type="remote"` and `url="http://127.0.0.1:8089/mcp"`.
- Prompt used:

```text
The configured MCP server name is subscribe-probe. Check the available MCP resources. Read test://review/status. If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification. After the notification, read test://review/status again. Report the final status, version, and message. Do not edit files or run shell commands.
```

- Result level: `1 - connected`
- Does it call `resources/list`? No. The isolated run produced only `[initialize] client connected` in the server log.
- Does it call `resources/read`? No.
- Does it call `resources/subscribe`? No.
- Does it receive or react to `notifications/resources/updated`? No. The server never received `resources/subscribe`, so no resource update notification was sent.
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt:

```text
[initialize] client connected
```

- OpenCode CLI command used for the isolated run:

```bash
opencode run "The configured MCP server name is subscribe-probe. Check the available MCP resources. Read test://review/status. If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification. After the notification, read test://review/status again. Report the final status, version, and message. Do not edit files or run shell commands."
```

- Observed OpenCode output:

```text
このセッションでは MCP リソース操作用のツールが公開されていないため、`subscribe-probe` のリソース一覧取得、`test://review/status` の読み取り、購読、更新通知待機を実行できません。

ファイル編集や shell コマンドは実行していません。
```

- `opencode mcp list` result:

```text
subscribe-probe failed
Failed to get tools
http://127.0.0.1:8089/mcp
```

- Notes: OpenCode connects to the server and completes `initialize`, but this resource-only server exposes no tools. OpenCode marks the MCP server as failed while getting tools and does not expose `resources/list`, `resources/read`, or `resources/subscribe` to the agent.

## Goose

- Date: 2026-05-08 11:57 +09:00
- Version: `goose 1.33.1`
- OS / shell: Windows / PowerShell 7
- MCP configuration: `subscribe-probe` registered as `type: streamable_http` with `uri: http://127.0.0.1:8089/mcp` in `%APPDATA%\Block\goose\config\config.yaml`. The `subscribe-probe` and `extensionmanager` extensions were both enabled.
- Prompt used:

```text
（今回のセッション内で検証を実施）
extensionmanager__list_resources(extension_name="subscribe-probe")
extensionmanager__read_resource(uri="test://review/status")
```

（`docs/verification-guide.md` の標準テストプロンプトと同等の操作を extensionmanager ツール経由で実施）

- Result level: `3 - read initial resource`
- Does it call `resources/list`? Yes. `extensionmanager__list_resources` が `test://review/status` を返した。サーバーログに `[resources/list] requested` が記録された。
- Does it call `resources/read`? Yes. `extensionmanager__read_resource` が `status: pending / version: 1` を返した。サーバーログに `[resources/read] uri=test://review/status version=1` が記録された。
- Does it call `resources/subscribe`? No. `extensionmanager` 拡張は `resources/subscribe` に対応するツールを提供しない。
- Does it receive or react to `notifications/resources/updated`? No. サブスクリプション自体が行われないため通知は受信できない。
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt:

```text
MCP resource subscribe test server listening on http://127.0.0.1:8089/mcp
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
```

- Notes: Goose は Streamable HTTP 経由の接続・初期化・リソース一覧取得・初回 read に成功する。しかし、現時点で `extensionmanager` 拡張が提供するツールに `resources/subscribe` 相当の機能が含まれていないため、サブスクリプション以降のステップには到達できない。`capabilities.resources.subscribe` フラグの認識可否は goose 内部の実装に依存するが、ツールとしては購読操作を起動する手段がなく Level 3 止まりとなった。

## GitHub Copilot CLI

- Date: 2026-05-08 14:13 +09:00
- Version: `github copilot 1.0.43`
- OS / shell: Windows 11 / PowerShell 7
- MCP configuration: Streamable HTTP server registered as `subscribe-probe` with `http://127.0.0.1:8080/mcp/subscribe-probe` (routed via mcp-gateway with `auth=none`; direct `http://127.0.0.1:8089/mcp` fails with "OAuth: needs authentication" because Copilot CLI requires OAuth for all `type: "http"` MCP servers).
- Prompt used: 検証担当エージェント自身が当 MCP サーバー（resource-only, subscribe-probe）に対して `docs/verification-guide.md` の標準テスト手順を試みた。subscribe-probe にはツールが登録されていないため、エージェントに公開されるツールが存在せず、`resources/list` / `resources/read` / `resources/subscribe` のいずれも呼び出せなかった。
- Result level: `1 - connected`
- Does it call `resources/list`? No. サーバーログに `[resources/list] requested` が現れなかった。
- Does it call `resources/read`? No.
- Does it call `resources/subscribe`? No.
- Does it receive or react to `notifications/resources/updated`? No. サブスクリプションが行われないためサーバーが通知を送信しない。
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt (fresh `docker compose restart` 後):

```text
MCP resource subscribe test server listening on http://127.0.0.1:8089/mcp
[initialize] client connected
[initialize] client connected
[initialize] client connected
[initialize] client connected
```

- Notes:
  - Copilot CLI は `type: "http"` MCP サーバーに対して OAuth を必須とする。直接 `http://127.0.0.1:8089/mcp` への接続は "OAuth: needs authentication" で失敗するため、mcp-gateway（port 8080）経由でルーティングし、`auth=none` を設定した上で検証を行った。
  - ゲートウェイログで確認できた接続フロー: GET `/.well-known/oauth-protected-resource/mcp/subscribe-probe` → 404（OAuth不要を確認）→ POST initialize → 200 → POST notifications/initialized → 202 → GET SSE stream → 200（長時間接続）→ 複数の POST → 200（おそらく `tools/list` 等）。
  - サーバーログには `[initialize]` のみが記録された。`[resources/list]` / `[resources/read]` / `[resources/subscribe]` はいずれも記録されなかった。
  - Subscribe-probe は resource-only（ツール登録なし）。Copilot CLI は `tools/list` から空リストを受け取っても接続エラーを報告せず（Crush のような "Method not found" エラーは発生しない）、ただしエージェントに公開されるケイパビリティがないためリソース操作には到達できない。
  - SSE GET ストリームを複数確立しており、通知受信チャンネルは技術的に保持されているが、サブスクリプションが発生しないため通知は送信されない。

## Claude Code

- Date: 2026-05-08 13:50 +09:00
- Version: `2.1.133 (Claude Code)`
- OS / shell: Windows 11 / PowerShell 7
- MCP configuration: Streamable HTTP server registered as `subscribe-probe` with `http://127.0.0.1:8089/mcp` (visible in `claude mcp list` as `subscribe-probe: http://127.0.0.1:8089/mcp (HTTP) - ✓ Connected`).
- Prompt used: 検証セッション内で Claude Code 自身の組み込み MCP ツール (`ListMcpResourcesTool`, `ReadMcpResourceTool`) を直接呼び出して `docs/verification-guide.md` の標準テスト手順を実施。
- Result level: `3 - read initial resource`
- Does it call `resources/list`? Yes. `ListMcpResourcesTool(server="subscribe-probe")` が `Review Status / test://review/status` を返した。サーバーログに `[resources/list] requested` が記録された。
- Does it call `resources/read`? Yes. `ReadMcpResourceTool(server="subscribe-probe", uri="test://review/status")` が `status: pending / version: 1 / message: Waiting for simulated review result.` を返した。サーバーログに `[resources/read] uri=test://review/status version=1` が記録された。
- Does it call `resources/subscribe`? No. Claude Code はエージェントから呼び出せる `resources/subscribe` 相当のツールを公開していない (利用可能な MCP リソース系ツールは `ListMcpResourcesTool` と `ReadMcpResourceTool` の 2 つのみ)。
- Does it receive or react to `notifications/resources/updated`? No. サブスクリプションが行われないため、サーバー側で更新通知トリガが発生しない。
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt (fresh `docker compose restart` 後):

```text
MCP resource subscribe test server listening on http://127.0.0.1:8089/mcp
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
```

- Observed agent-visible resource content (initial read):

```text
status: pending
version: 1
message: Waiting for simulated review result.
```

- Notes:
  - Claude Code は Streamable HTTP 経由で `initialize` / `resources/list` / `resources/read` を正常にサポートする。
  - `capabilities.resources.subscribe` フラグの解釈可否はクライアント内部の挙動に依存するが、エージェントから呼び出せるツール表面に subscribe オペレーションが存在しないため、テストプロンプトの指示通りに購読を試みても Level 4 以降には到達できない。
  - `tools/list` 失敗 (resource-only サーバーで他クライアントが詰まったケース) は Claude Code では発生しない。リソース系ツールは tools とは独立に提供されているため、resource-only サーバーでも機能する。

## Crush

- Date: 2026-05-08 13:24 +09:00
- Version: `crush v0.66.0`
- OS / shell: Windows / PowerShell 7
- MCP configuration: Streamable HTTP server configured in `.crush.json` with `mcp.subscribe-probe.type="http"` and `url="http://127.0.0.1:8089/mcp"`.
- Prompt used:

```text
Check the available MCP resources.
Read test://review/status.
If the server supports resource subscription, subscribe to test://review/status and wait for the resource update notification.
After the notification, read test://review/status again.
Report the final status, version, and message.
```

- Result level: `1 - connected`
- Does it call `resources/list`? No. The server log shows only the listening message; no `[resources/list] requested` appeared.
- Does it call `resources/read`? No.
- Does it call `resources/subscribe`? No.
- Does it receive or react to `notifications/resources/updated`? No.
- Does it re-read after update? No.
- Does the final answer mention `status: reviewed` and `version: 2`? No.
- Server log excerpt:

```text
MCP resource subscribe test server listening on http://127.0.0.1:8089/mcp
```

- Crush internal log excerpt (from crush logs):

```text
13:12:12 INFO  init.go:167 Initializing MCP clients
13:12:12 ERROR init.go:246 Error listing tools error="calling \"tools/list\": Method not found"
```

- Notes: Crush connects to the MCP server and completes `initialize` (the `tools/list` call reaching the server confirms a connection was established), but immediately calls `tools/list` during startup. The resource-only server returns `-32601 Method not found`, causing Crush to mark the MCP server as unavailable. As a result, `resources/list`, `resources/read`, and `resources/subscribe` are never called. The server did not emit `[initialize] client connected` to stdout (it did receive the HTTP request but the log did not appear in `docker compose logs`; the initialize handshake is confirmed only through Crush's own internal error log referencing the subsequent `tools/list` failure). This is the same pattern as OpenCode.
