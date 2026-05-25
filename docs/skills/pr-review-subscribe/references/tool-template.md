# pr-review-subscribe Tool Template

Copy this template mentally before running the skill and replace the placeholders with the active tool names and resource URI shape in the current Codex session.

## Required Values

```text
OWNER=<repository owner>
REPO=<repository name>
PR=<pull request number>
CRM_SERVER=<copilot review MCP server name>
GITHUB_SERVER=<GitHub MCP server name>
RESOURCE_SERVER=<MCP resource server name, if different from CRM_SERVER>
WATCH_RESOURCE_URI_TEMPLATE=<resource URI template>
```

Recommended watch resource URI shape:

```text
copilot-review://watch/{watch_id}
```

Alternative PR-scoped shape:

```text
copilot-review://pr/{owner}/{repo}/pull/{pr}/review-status
```

Prefer a `resource_uri` returned by `start_copilot_review_watch` over constructing one.

## Tool Mapping

Map these placeholders to the available tools in the current runtime:

```text
{CRM}:get_copilot_review_status
{CRM}:request_copilot_review
{CRM}:start_copilot_review_watch
{CRM}:get_copilot_review_watch_status
{CRM}:cancel_copilot_review_watch
{CRM}:get_review_threads
{CRM}:reply_and_resolve_review_thread
{CRM}:get_pr_review_cycle_status

{GH}:add_issue_comment
{GH}:add_reply_to_pull_request_comment  (Human review route: reply to inline thread; actual operation name varies by MCP server — e.g. reply_to_review_comment)

{RSRC}:list_resources
{RSRC}:read_resource
{RSRC}:subscribe_resource
{RSRC}:unsubscribe_resource
```

Examples:

```text
{CRM}=mcp__copilot_review__
{GH}=mcp__github__
{RSRC}=native MCP resource tools, a subscribe-capable connector, or a local SDK client wrapper
```

## Subscription Main Route Contract

`{CRM}:start_copilot_review_watch` should return:

```json
{
  "watch_id": "cw_...",
  "resource_uri": "copilot-review://watch/cw_...",
  "recommended_next_action": "POLL_AFTER",
  "next_poll_seconds": 90
}
```

The resource read result should include enough structured or parseable fields to route the cycle:

```json
{
  "watch_id": "cw_...",
  "review_status": "PENDING | IN_PROGRESS | COMPLETED | BLOCKED",
  "recommended_next_action": "POLL_AFTER | READ_REVIEW_THREADS | CHECK_FAILURE | REAUTH_AND_START_NEW_WATCH | START_NEW_WATCH",
  "next_poll_seconds": 90,
  "error": null
}
```

If the resource body is plain text, parse only stable `key: value` lines. Do not infer terminal completion from prose when a structured field is available.

## Fallback Polling Contract

Use `{CRM}:get_copilot_review_watch_status` only after the subscription route is unavailable or unhealthy.

Fallback response should expose the same routing fields:

```json
{
  "watch": {
    "watch_id": "cw_...",
    "resource_uri": "copilot-review://watch/cw_...",
    "review_status": "IN_PROGRESS",
    "recommended_next_action": "POLL_AFTER",
    "next_poll_seconds": 90,
    "terminal": false
  }
}
```

## Local SDK Wrapper Pattern

If Codex has no native `resources/subscribe` tool but shell execution is allowed, a project may provide an SDK wrapper. Treat it as `{RSRC}` only when the user or repository explicitly allows that workaround.

Template command (recommended — published package):

```bash
pnpm dlx mcp-resource-subscriber --url <mcp-url> --uri <watch-resource-uri> --timeout-ms 900000
```

Fallback if `pnpm` is unavailable:

```bash
npx mcp-resource-subscriber --url <mcp-url> --uri <watch-resource-uri> --timeout-ms 900000
```

Local build (for unreleased changes — requires `npm ci && npm run build` first):

```bash
node <path-to-client.js> --url <mcp-url> --uri <watch-resource-uri> --timeout-ms 900000
```

The wrapper must:

1. Connect to the MCP server.
2. Subscribe to the watch resource.
3. Wait for `notifications/resources/updated`.
4. 通知ごとに同じ resource を再読込する。
5. `recommended_next_action=POLL_AFTER` の場合は subscription を維持し、次の通知を待つ。
6. 非 `POLL_AFTER` action、timeout、error のいずれかに到達してから parsed `recommended_next_action` を返す。
7. Unsubscribe/close on completion or timeout.

