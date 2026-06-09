# mcp-resource-subscriber

CLI probe for MCP `resources/subscribe` — connects to any MCP Streamable HTTP server, subscribes to a resource, receives live update notifications, and re-reads updated content.

---

## Install

```bash
# recommended (no install):
pnpm dlx mcp-resource-subscriber --url <mcp-server-url> --uri <resource-uri>

# or install globally:
pnpm add --global mcp-resource-subscriber
mcp-resource-subscriber --url <mcp-server-url> --uri <resource-uri>
```

> **パッケージマネージャー方針**: このリポジトリと README の利用例は pnpm を前提にしています。pnpm がない環境では、先に pnpm を利用できる状態にしてください。

> **Note**: A reference MCP test server used during compatibility verification is also included in this repository (Docker Compose). See the [Lab Server](#lab-server) section below.

---

## CLI Usage

### Against `copilot-review-mcp`

```bash
mcp-resource-subscriber \
  --url http://127.0.0.1:8080/mcp/copilot-review \
  --uri copilot-review://watch/<watch_id> \
  --timeout-ms 900000
```

`copilot-review-mcp` is the `@scottlz0310/copilot-review-mcp` server. Replace `<watch_id>` with the ID returned by `start_copilot_review_watch`.

### Against the bundled test server

```bash
# Start the test server first:
docker compose up --build
# or: pnpm run dev

mcp-resource-subscriber --url http://127.0.0.1:8089/mcp
```

> **Note**: `test://review/status` is the default resource URI and is **only meaningful against the bundled test server**. For any other MCP server, always pass `--uri` explicitly.

### Options

```
  --url <url>         MCP server Streamable HTTP endpoint (required)
                      Env: MCP_PROBE_URL
  --uri <uri>         Resource URI to subscribe to
                      Default: test://review/status (bundled test server only)
                      Env: MCP_PROBE_URI
  --auth-token <tok>  Bearer token for Authorization header
                      Prefer MCP_PROBE_AUTH_TOKEN env var (flag is visible in
                      process lists and may be stored in shell history)
                      Env: MCP_PROBE_AUTH_TOKEN (recommended)
  --skip-resource-list-check
                      Skip resources/list and assume the URI exists.
                      Use for servers with dynamic resources not in list.
                      Env: MCP_PROBE_SKIP_LIST_CHECK=true
  --timeout-ms <ms>   Notification wait timeout in ms (default: 15000)
                      Env: MCP_PROBE_TIMEOUT_MS
  --json              Emit a single JSON object to stdout instead of line-based output.
                      Diagnostic messages are written to stderr only.
  --version, -v       Print version and exit
  --help, -h          Print this help and exit
```

### JSON output mode

Pass `--json` to emit a single JSON object to stdout for agent workflow integration:

```bash
mcp-resource-subscriber \
  --url http://localhost:3000/mcp \
  --uri queue://review/re-review-requests \
  --timeout-ms 900000 \
  --json
```

Success output:

```json
{
  "route": "subscription",
  "serverUrl": "http://localhost:3000/mcp",
  "resourceUri": "queue://review/re-review-requests",
  "subscribed": true,
  "notificationReceived": true,
  "notificationCount": 1,
  "unsubscribed": true,
  "errorCode": null,
  "initialText": "...",
  "finalText": "...",
  "recommendedNextAction": null
}
```

Failure output (same shape with non-null `errorCode`):

```json
{
  "route": "timeout",
  "serverUrl": "http://localhost:3000/mcp",
  "resourceUri": "queue://review/re-review-requests",
  "subscribed": true,
  "notificationReceived": false,
  "notificationCount": 0,
  "unsubscribed": true,
  "errorCode": "NOTIFICATION_TIMEOUT",
  "initialText": null,
  "finalText": null,
  "recommendedNextAction": null
}
```

- `route`: `"subscription"` | `"pre-completion"` | `"timeout"` | `"failed"`
- `notificationReceived`: `true` when `route === "subscription"`
- `recommendedNextAction`: extracted from `finalText` if present, otherwise `null`
- If `finalText` is JSON, callers can parse it themselves
- Diagnostic warnings (e.g. `--auth-token` flag warning) go to stderr and do not corrupt stdout JSON

### Structured line-based output (default)

Every run emits machine-parseable lines:

```
capabilities {"subscribe":true,"listChanged":true}
resource-found true
resource-uri <resource-uri>
server-url <url>
initial
<initial resource text>
route subscription
subscribed true
notification-received true
notification-count 1
unsubscribed true
recommended_next_action READ_REVIEW_THREADS
error-code null
notification <resource-uri>
final
<updated resource text>
phase-summary route=subscription url=<url> uri=<uri>
```

> **Note**: `recommended_next_action` is only emitted when the final resource text contains it (e.g., from `copilot-review-mcp`). It is omitted for the bundled test server.

`recommended_next_action=POLL_AFTER` は非終端状態として扱われます。この場合、CLI は exit せず、同じ購読を維持したまま次の `notifications/resources/updated` を待ちます。`--timeout-ms` は subscribe 後の全体待機上限です。

On failure:

```
error-code SERVER_URL_UNKNOWN
phase-summary route=failed url=unknown error-code=SERVER_URL_UNKNOWN
```

```
error-code RESOURCE_NOT_FOUND
phase-summary route=timeout url=<url> uri=<uri> error-code=RESOURCE_NOT_FOUND
```

```
error-code NOTIFICATION_TIMEOUT
phase-summary route=timeout url=<url> uri=<uri> error-code=NOTIFICATION_TIMEOUT
```

---

## Lab Server

Minimal MCP Streamable HTTP server for testing whether MCP clients correctly handle `resources/subscribe` and `notifications/resources/updated`.

This repository is meant to be a reproducible issue / compatibility lab for CLI AI agents such as Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI, Claude Code, Goose, and Crush.

## Purpose

The server exposes one fixed MCP resource:

```text
test://review/status
```

Initial content:

```text
status: pending
version: 1
message: Waiting for simulated review result.
```

After a client subscribes to the resource, the server waits for `MCP_TEST_UPDATE_DELAY_SECONDS`, changes the resource, and sends:

```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "test://review/status"
  }
}
```

Updated content:

```text
status: reviewed
version: 2
message: Simulated review result is now available.
```

## Why Resources/Subscribe Instead Of Tools/Call

`tools/call` is useful for explicit actions, but many agent workflows depend on context that changes after the original request. Polling every source is noisy and client-specific. MCP resource subscriptions give clients a protocol-level way to learn that a known context object changed and should be re-read.

Examples where subscription behavior matters:

- Copilot review result
- PR review thread
- CI status
- Codecov comment
- GitHub issue discussion
- local build/test result

This test server focuses on whether the client notices a resource update, re-runs `resources/read`, and reflects the new content in the agent loop / model context.

## Start

```bash
docker compose up --build
```

MCP URL:

```text
http://127.0.0.1:8089/mcp
```

For local development:

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `MCP_TEST_PORT` | `8089` | TCP port the server listens on |
| `MCP_TEST_PATH` | `/mcp` | Additional MCP endpoint path. The server always registers `/mcp`; this adds a second path (e.g. `/mcp/subscribe-probe` for gateway routing). Both paths share the same MCP handler. |
| `MCP_TEST_UPDATE_DELAY_SECONDS` | `5` | Seconds to wait before sending the resource update notification |
| `MCP_TEST_INITIAL_STATUS` | `pending` | Initial value of the `status` field in the resource |
| `MCP_TEST_UPDATED_STATUS` | `reviewed` | Value of `status` after the simulated update |
| `MCP_TEST_SEND_LIST_CHANGED` | `false` | Also send `notifications/resources/list_changed` after the update |
| `MCP_TEST_LOG_LEVEL` | `debug` | Log verbosity (`debug` / `info` / `warn` / `error` / `silent`) |

If `MCP_TEST_SEND_LIST_CHANGED=true`, the server also sends `notifications/resources/list_changed` after the simulated update.

## Expected Client Behavior

An ideal MCP client should follow this flow:

```text
initialize
  ↓
resources/list
  ↓
resources/read test://review/status
  ↓
resources/subscribe test://review/status
  ↓
receive notifications/resources/updated
  ↓
resources/read test://review/status again
  ↓
reflect updated status: reviewed in agent context
```

## Server Capabilities

The initialize response advertises:

```json
{
  "resources": {
    "subscribe": true,
    "listChanged": true
  }
}
```

## Implemented MCP Messages

- `initialize`
- `resources/list`
- `resources/read`
- `resources/subscribe`
- `resources/unsubscribe`
- `notifications/resources/updated`
- `notifications/resources/list_changed` when `MCP_TEST_SEND_LIST_CHANGED=true`

No tools are implemented.

## Logs

The server logs each important message so client behavior can be checked objectively:

```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
[resources/subscribe] uri=test://review/status
[resource/update] uri=test://review/status version=2
[notification/send] notifications/resources/updated uri=test://review/status
[resources/read] uri=test://review/status version=2
[resources/unsubscribe] uri=test://review/status
```

The key evidence for resource subscription support is:

```text
resources/subscribe was received
notification was sent
resources/read was received again after the notification
```

## Tests

```bash
pnpm test
```

The test suite verifies:

- `resources/list` returns `test://review/status`
- initial `resources/read` returns version 1
- `resources/subscribe` triggers an internal update to version 2
- `notifications/resources/updated` is received
- updated `resources/read` returns version 2

## Standalone Subscription Probe Client

The repository also includes a reusable MCP SDK client that exercises the full subscription flow against a running server:

```bash
pnpm run probe:subscribe -- --url http://127.0.0.1:8089/mcp
```

After `pnpm run build`, the same client can be run directly with Node:

```bash
node dist/src/client/cli.js --url http://127.0.0.1:8089/mcp
```

This client is separate from any AI client's native MCP surface. For Codex CLI, it demonstrates a reproducible agent-driven SDK workaround: if the agent has shell, Node.js, local dependency, and localhost network access, it can run this client to call `resources/subscribe`, receive `notifications/resources/updated`, and re-read the updated resource.

## Verification Procedure

Use [`docs/verification-guide.md`](docs/verification-guide.md) for a repeatable client verification procedure.

Record results in [`results/compatibility-matrix.md`](results/compatibility-matrix.md).

## Skill Templates

Reusable Codex skill templates are tracked under [`docs/skills`](docs/skills). The `pr-review-subscribe` template documents a PR review cycle that uses MCP `resources/subscribe` as the primary wait route and polling only as fallback.

## Client Compatibility

See [`results/compatibility-matrix-v2.md`](results/compatibility-matrix-v2.md) for the current Round 2 compatibility matrix (tool + resource testing) across Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI, Claude Code, Goose, and Crush.
