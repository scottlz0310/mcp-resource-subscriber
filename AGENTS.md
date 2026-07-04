# AGENTS.md

## Project Purpose

This repository is a **compatibility lab** for MCP `resources/subscribe`. It contains two things:

1. **A reference MCP Streamable HTTP server** — exposes one resource (`test://review/status`) that updates after a client subscribes, then sends `notifications/resources/updated`.
2. **A reusable subscription probe client** (`src/client/probeClient.ts`) — exercises the full subscribe→notify→re-read flow against any running server.

The goal is reproducible testing of whether CLI AI agents (Codex, Gemini, Claude Code, Crush, etc.) correctly handle MCP resource subscriptions.

## Essential Commands

```bash
pnpm install --frozen-lockfile # install dependencies
pnpm run build                 # tsc compile → dist/
pnpm test                      # vitest run (tests against in-process server, no Docker needed)
pnpm run typecheck             # tsc --noEmit (no output files)
pnpm run dev                   # run server locally via tsx (no build step)
pnpm run probe:subscribe -- --url http://127.0.0.1:8089/mcp  # run probe client against live server
docker compose up --build      # start reference server on port 8089
```

**Node requirement**: `>=26.2.0` (enforced in `package.json` engines and CI).
**Package manager**: `pnpm@11.4.0` (pinned by `packageManager`; `pnpm-lock.yaml` is the only lockfile).

## Architecture

```
src/
  server/
    index.ts         — entrypoint: reads env config, starts Express HTTP server
    config.ts        — TestConfig type + configFromEnv() (all env vars parsed here)
    httpServer.ts    — createMcpHttpApp(): wires McpServer → Express via StreamableHTTP transport
    mcpServer.ts     — createProbeServer(): registers MCP handlers (list/read/subscribe/unsubscribe + tool)
    resourceState.ts — ReviewStatusStore (in-memory, version 1→2), renderReviewStatus(), constants
    logger.ts        — createConsoleLogger(config): returns a LogSink that outputs all lines unless logLevel is 'silent' (no level hierarchy filtering)
  client/
    probeClient.ts   — runSubscribeProbe(): SDK client that exercises the full flow, returns typed result
    cli.ts           — published bin entry; supports --url, --uri, --auth-token, --login, --skip-resource-list-check, --timeout-ms
    auth/
      tokenStore.ts  — node:sqlite token cache (one row per gateway origin, OS state dir, 0600); withExclusiveLock() accepts an optional timeoutMs that temporarily lowers busy_timeout so BEGIN IMMEDIATE's synchronous wait cannot exceed it (raises LockTimeoutError)
      oauthClient.ts — RFC 8414 discovery / RFC 7591 DCR / RFC 8628 device flow / refresh grant (fetch + sleep injectable)
      gatewayAuth.ts — loginToGateway() and resolveCachedToken() (auto-refresh with rotation persistence)

scripts/
  subscribe-client.ts  — thin wrapper that calls runSubscribeProbe() with CLI args, prints result

test/
  mcp-resource-subscribe.test.ts  — vitest integration tests (spin up in-process server on port 0)
  e2e.test.ts                     — E2E tests against external copilot-review-mcp server (requires env vars)
  tokenStore.test.ts              — token cache CRUD against a temp SQLite file
  oauthClient.test.ts             — device flow / refresh against an in-process mock authorization server
  gatewayAuth.test.ts             — login + cached-token resolution (refresh, rotation, re-login errors)
  cliAuth.test.ts                 — CLI subprocess auth integration (--login, cache precedence, AUTH_LOGIN_REQUIRED)
  helpers/mockAuthServer.ts       — express mock of mcp-gateway's OAuth surface
```

## Key Patterns

**Dual-role repo**: `src/server/` (server) and `src/client/` (client) are both first-class. The server is for Docker/manual testing; the probe client is published in the package (`dist/src/client/probeClient.js`) and the CLI bin is `dist/src/client/cli.js`.

**`createProbeServer()` triggers the update only on subscribe**: `scheduleUpdate()` is called inside the `SubscribeRequestSchema` handler. The timer fires after `updateDelaySeconds` seconds. In tests, this is set to `0.05` so tests run fast — don't use the production default (5s) in tests.

**Subscription set is in-memory and per-server instance**: `subscriptions` is a `Set<string>` local to each `createProbeServer()` call. Each test creates a new server instance on port 0.

**`McpServer` vs `McpServer.server`**: The SDK's `McpServer` (high-level) wraps a low-level `server` property. `registerTool()` is on the high-level wrapper; `setRequestHandler()` for resources/subscribe/unsubscribe must be called on `.server` directly because the high-level API doesn't expose them. `sendResourceUpdated()` is also on `.server`.

**Imports use `.js` extensions**: TypeScript is compiled with `moduleResolution: NodeNext`. All relative imports must end in `.js` even in `.ts` source files.

**`tsconfig.json` `rootDir` is `.`**: Both `src/`, `test/`, and `scripts/` are compiled to `dist/` preserving the same subdirectory structure. `dist/src/client/cli.js` is the published bin entry.

## Configuration (Environment Variables)

| Variable | Default | Notes |
|---|---|---|
| `MCP_TEST_PORT` | `8089` | |
| `MCP_TEST_PATH` | `/mcp` | Adds a second path alias; `/mcp` is always registered |
| `MCP_TEST_UPDATE_DELAY_SECONDS` | `5` | Set to `0` or `0.05` for fast local testing |
| `MCP_TEST_INITIAL_STATUS` | `pending` | |
| `MCP_TEST_UPDATED_STATUS` | `reviewed` | |
| `MCP_TEST_SEND_LIST_CHANGED` | `false` | Also sends `notifications/resources/list_changed` after update |
| `MCP_TEST_LOG_LEVEL` | `debug` | `debug`/`info`/`warn`/`error`/`silent` |

## Testing

Tests are integration tests — they spin up a real HTTP server on port `0` (OS-assigned) using `createMcpHttpApp()` and connect a real MCP SDK client. No mocking of transport or protocol. Tests use `afterEach` to close all servers and clients.

The `updateDelaySeconds: 0.05` in test config is critical — the notification timeout in tests is 2000ms so there's headroom, but production delay (5s) would make tests slow.

Three test cases:
1. `get_review_status` tool is listed and callable
2. Full subscribe→notify→re-read flow with log assertion
3. `runSubscribeProbe()` probe client exercised end-to-end

## Results and Docs

- `results/compatibility-matrix.md` — Round 1 compatibility matrix (resource-only testing)
- `results/compatibility-matrix-v2.md` — Round 2 compatibility matrix (tool + resource testing, current)
- `results/` — session logs from individual agent testing runs
- `docs/verification-guide.md` — Round 1 manual verification procedure
- `docs/verification-guide-v2.md` — Round 2 manual verification procedure (current)
- `docs/skills/pr-review-subscribe/SKILL.md` — Codex skill template for PR review via subscribe

## CLI Status

`src/client/cli.ts` is the published bin entry (`dist/src/client/cli.js`). It supports `--url`, `--uri`, `--auth-token`, `--login`, `--skip-resource-list-check`, `--timeout-ms`, `--version`, and `--help`. The actual probe functionality is in `src/client/probeClient.ts`.

**Gateway auth precedence** (`src/client/auth/`): explicit `--auth-token` / `MCP_PROBE_AUTH_TOKEN` always wins; otherwise the SQLite token cache for the `--url` origin is consulted (auto-refresh with rotation persistence); probe runs never create the cache — only `--login` does. `MCP_PROBE_TOKEN_STORE_PATH` overrides the cache path (tests rely on this for isolation). `resolveCachedToken`'s refresh path — cross-process lock wait *and* network calls (endpoint discovery + refresh grant) — is bounded by the same `--timeout-ms` budget: the deadline is computed before `withExclusiveLock()`, which itself receives that `timeoutMs` and temporarily lowers SQLite's `busy_timeout` so `BEGIN IMMEDIATE`'s synchronous wait cannot silently exceed it (raising `LockTimeoutError` otherwise). The `AbortSignal.timeout()` passed to the network calls then uses whatever budget remains after lock acquisition (already-spent budget fails fast with `AuthTimeoutError` instead of starting a doomed network call). Exceeding either bound raises `AuthTimeoutError` → `error-code AUTH_TIMEOUT`, and the CLI subtracts the elapsed auth time from the budget it passes to `runSubscribeProbe`.

## Secret and Log Handling

Before posting logs, command output, PR descriptions, issue comments, review summaries, or E2E reports to GitHub, redact all secrets.

Never paste raw values that look like:

- GitHub tokens: `ghp_`, `gho_`, `github_pat_`
- npm tokens: `npm_`
- Bearer tokens or OAuth tokens
- `Authorization:` header values
- `MCP_PROBE_AUTH_TOKEN`, `MCP_E2E_TOKEN`, `NODE_AUTH_TOKEN`
- cookies, session IDs, refresh tokens, private keys, or client secrets

Use placeholders instead:

- `<redacted>`
- `<token>`
- `Bearer <redacted>`
- `$(gh auth token)` in command examples

If a secret is accidentally posted publicly, treat it as compromised even if it is edited out later. Immediately rotate or revoke the token, then replace the public text with a placeholder.

Do not include raw environment dumps in PRs, issues, comments, or committed logs.

For E2E evidence, preserve protocol facts but redact credentials:

- Keep: server URL, resource URI, route, subscribed, notification-received, unsubscribed, error-code, phase-summary
- Redact: Authorization headers, token values, cookies, sessions, OAuth responses, refresh tokens
