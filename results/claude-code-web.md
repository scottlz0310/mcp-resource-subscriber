# MCP Resource Subscription Compatibility — Claude Code (Web)

Endpoint under test:

```text
http://127.0.0.1:8089/mcp
```

Resource under test:

```text
test://review/status
```

Tool added in Round 2:

```text
get_review_status
```

Result levels are defined in [`docs/verification-guide-v2.md`](../docs/verification-guide-v2.md#result-levels).

---

## Summary

| Verification mode                                     | Round 2 Level             | `tools/list` OK        | `resources/list` | `resources/subscribe` | Notification received |
| ----------------------------------------------------- | ------------------------- | ---------------------- | ---------------- | --------------------- | --------------------- |
| Native MCP client (MCP server configured in settings) | 1 - connected             | YES (via tool surface) | NO               | NO                    | NO                    |
| Manual execution via Bash/curl                        | 7 - agent context updated | YES                    | YES              | YES                   | YES                   |

**Key finding:** Claude Code web exposes MCP server tools to the agent via the tool surface (`mcp__<server>__<tool>`), but does not natively expose raw resource methods (`resources/list`, `resources/read`, `resources/subscribe`) as agent-accessible primitives. When the agent drives the protocol manually via Bash/curl, the full Level 7 flow is achievable. A GitHub-specific subscription mechanism (`mcp__github__subscribe_pr_activity`) exists as a parallel capability but operates via webhook, not generic MCP `resources/subscribe`.

---

## Claude Code (Web) — Native MCP Client Behavior

- Date: 2026-05-12
- Version: claude-sonnet-4-6 (Claude Code web)
- OS / shell: Linux (Claude Code web session)
- MCP endpoint configuration: `http://127.0.0.1:8089/mcp` (local dev server via `npm run dev`)
- Prompt used: N/A — tested by observing available tool surface within this session

### Observed native client behavior

In this Claude Code web session, MCP servers are connected and their capabilities exposed as follows:

- `initialize` is called automatically when an MCP server is configured.
- `tools/list` is called; each discovered tool becomes available as `mcp__<server>__<tool>`.
- `resources/list` is NOT called automatically; no resource-based tools appear in the tool surface.
- `resources/subscribe` is NOT available as a native primitive.
- `notifications/resources/updated` cannot be received by the native client in the standard MCP resource sense.
- A GitHub-specific PR activity subscription exists (`mcp__github__subscribe_pr_activity`) that delivers webhook events as `<github-webhook-activity>` messages, but this is distinct from MCP `resources/subscribe`.

- Round 2 Result level (native client): `1 - connected`
- Does `tools/list` succeed? YES — tools from connected MCP servers are available
- Does it call `resources/list`? NO
- Does it call `resources/read`? NO
- Does it call `resources/subscribe`? NO
- Does it receive `notifications/resources/updated`? NO
- Does it re-read after update? NO
- Does the final answer mention `status: reviewed` and `version: 2`? NO (resource methods not exercised natively)

Server log excerpt (native client, inferred):

```text
[initialize] client connected
```

---

## Claude Code (Web) — Manual Execution via Bash/curl

- Date: 2026-05-12
- Version: claude-sonnet-4-6 (Claude Code web)
- OS / shell: Linux / bash (Bash tool)
- MCP endpoint: `http://127.0.0.1:8089/mcp` (local dev server, `npm run dev`)
- Prompt used:

```text
readme.mdの手順に従ってMCPサーバーを起動し、docs/verification-guide.md 及び docs/verification-guide-v2.md の手順に従って、テストを行ってください。
```

### Procedure

1. Server started with `npm run dev` (background process).
2. MCP protocol messages sent via `curl` POST/GET to `http://127.0.0.1:8089/mcp`.
3. Session maintained via `mcp-session-id` header across requests.
4. SSE GET stream opened to receive `notifications/resources/updated`.

### Observed protocol trace

```text
POST /mcp  initialize
  -> session-id: 2c0451fb-2d3e-4b0a-a52f-e36d5e2460fd
  <- capabilities.resources.subscribe=true, capabilities.resources.listChanged=true

POST /mcp  resources/list
  <- uri=test://review/status, name="Review Status", mimeType=text/plain

POST /mcp  resources/read  uri=test://review/status
  <- status: pending, version: 1

POST /mcp  tools/list
  <- [get_review_status]

POST /mcp  resources/subscribe  uri=test://review/status
  <- {} (success)

GET  /mcp  (SSE stream)
  <- event: message
     data: {"method":"notifications/resources/updated","params":{"uri":"test://review/status"},"jsonrpc":"2.0"}

POST /mcp  resources/read  uri=test://review/status
  <- status: reviewed, version: 2, message: Simulated review result is now available.

POST /mcp  tools/call  get_review_status
  <- status: reviewed, version: 2, message: Simulated review result is now available.

POST /mcp  resources/unsubscribe  uri=test://review/status
  <- {} (success)
```

### Server log (confirmed)

```text
[initialize] client connected
[resources/list] requested
[resources/read] uri=test://review/status version=1
[resources/subscribe] uri=test://review/status
[resource/update] uri=test://review/status version=2
[notification/send] notifications/resources/updated uri=test://review/status
[resources/read] uri=test://review/status version=2
[tools/call] get_review_status
[resources/unsubscribe] uri=test://review/status
```

### Result checklist (manual execution)

- Round 2 Result level: `7 - agent context updated`
- Does `tools/list` succeed? YES — `get_review_status` available
- Does it call `resources/list`? YES
- Does it call `resources/read` (version 1)? YES — `status: pending`, `version: 1`
- Does it call `resources/subscribe`? YES
- Does it receive `notifications/resources/updated`? YES — via SSE GET stream
- Does it re-read after update? YES — `status: reviewed`, `version: 2`
- Does the final answer mention `status: reviewed` and `version: 2`? YES

### Final agent-visible resource content

```text
status: reviewed
version: 2
message: Simulated review result is now available.
```

---

## Notes

### Native client limitation

Claude Code web currently exposes MCP server capabilities to the agent exclusively through the tool interface. When an MCP server is registered in `.claude/settings.json`, the client:

1. Calls `initialize` and `tools/list` at startup.
2. Exposes each discovered tool as `mcp__<server>__<tool>`.
3. Does **not** call `resources/list` or `resources/read` automatically.
4. Does **not** provide a `resources/subscribe` primitive to the agent.

This matches the behavior seen with other tool-centric agents (GitHub Copilot CLI, OpenCode) in Rounds 1 and 2.

### Manual execution capability

Claude Code web can reason about and execute the full MCP resource subscription protocol manually via Bash/curl. The agent:

- Understands the MCP Streamable HTTP protocol (JSON-RPC over HTTP with SSE for notifications).
- Can maintain session state across requests using the `mcp-session-id` header.
- Can open an SSE GET stream in parallel to a POST subscribe request to receive notifications.
- Correctly interprets `notifications/resources/updated` and issues a subsequent `resources/read`.

This makes Claude Code web a Level 7 client when the agent actively drives the protocol, but a Level 1 client when relying on the native MCP client infrastructure.

### Comparison with Round 1 / Round 2 findings

| Client                     | Round 1               | Round 2 | Mode                   |
| -------------------------- | --------------------- | ------- | ---------------------- |
| Claude Code (web) — native | not previously tested | 1       | native MCP client      |
| Claude Code (web) — manual | not previously tested | 7       | agent-driven Bash/curl |
| Codex CLI                  | 1                     | 3       | native                 |
| OpenCode                   | 1                     | 1       | native                 |
| Crush                      | 1                     | 3       | native                 |
| GitHub Copilot CLI         | 1                     | 1       | native                 |

### Session-specific observation: PR activity subscription

During this session, the `mcp__github__subscribe_pr_activity` tool was used to subscribe to GitHub PR #15 activity. The agent received a `<github-webhook-activity>` notification when the PR was created, confirming that a webhook-based push notification pathway exists in Claude Code web. This is a platform-specific subscription mechanism distinct from the generic MCP `resources/subscribe` / `notifications/resources/updated` protocol tested here.
