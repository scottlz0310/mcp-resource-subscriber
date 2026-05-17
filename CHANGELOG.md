# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `pr-review-subscribe` skill: scope-out / deferred reject を完了扱いにする際の追跡 Issue 必須化ルールを `docs/skills/pr-review-subscribe/SKILL.md` に追加（#51）
  - Required Surfaces に `{GH}:create_issue` を追加（follow-up issue 作成を skill 仕様として明示）
  - Phase 3 decision table に `Follow-up issue` 列を追加し、`out-of-scope` / `deferred` / `follow-up` reject では issue 番号必須と明記
  - Phase 5 に reject 種別ごとの返信ルールを追加（既存Issue流用禁止、新規issue作成手順、`Won't fix` の扱い、Issue作成不可時はthread未resolveまたは`needs user decision`で停止）
  - Phase 7 Summary に `### Deferred / Scope-out Items` セクションを新設し、`- None` 可とする条件を明確化

### Fixed

- `mcp-resource-subscriber` CLI/probe は `recommended_next_action=POLL_AFTER` を非終端として扱い、同じ subscription を維持して次の `notifications/resources/updated` を待つようになりました（#52）
- `POLL_AFTER` 後の `resources/read` 中に届いた次の通知を消費済みにせず、終端更新を取りこぼさないようにしました

## [0.1.2] - 2026-05-15

### Changed

- `pr-review-subscribe` skill: extended termination classification taxonomy in `docs/skills/pr-review-subscribe/SKILL.md` (closes #36)
  - Phase 6 now records `termination_status` as one of `READY_TO_MERGE`, `ESCALATE — Clean`, or `ESCALATE — Unverified Fix`
  - Phase 7 summary template surfaces the classification, unverified blocking commit SHA(s), and a human-review recommendation when applicable
  - Phase 8 merge gate downgrades merge readiness on `ESCALATE — Unverified Fix` regardless of CI status
- Distinguishes safe ESCALATE (max cycles reached with only non-blocking items) from risky ESCALATE (final cycle accepted a blocking fix that Copilot has not re-reviewed)

### Notes

- Spike-to-CLI transition completed (closes #19); all 7 subtasks (#22, #24, #26, #27, #28, #29, #30) had already shipped
- No functional behavior changes in this release; bumps internal version strings (observable via MCP `initialize` handshake) to keep `package.json`, `src/server/mcpServer.ts`, and `src/client/probeClient.ts` in sync per the CHANGELOG 0.1.0 note

## [0.1.1] - 2026-05-14

### Changed

- `pr-review-subscribe` skill: probe commands updated from `npm run probe:subscribe` / local `node dist/` invocations to `pnpm dlx mcp-resource-subscriber` (published package)
- `pnpm dlx` established as primary invocation, `npx` as fallback when pnpm is unavailable — consistently across README, SKILL.md, and `tool-template.md`
- Version-pinning note clarified: "default to latest published version"; added `@<version>` pinning example for reproducible probes

### Fixed

- README Install section: reordered to show `pnpm dlx` first, `npx` as fallback
- `tool-template.md` Local SDK Wrapper Pattern: added `pnpm dlx` primary and `npx` fallback commands alongside the existing `node` local-build option

## [0.1.0] - 2026-05-14

### Added

- CLI probe (`mcp-resource-subscriber`) for MCP `resources/subscribe` — connects to any MCP Streamable HTTP server, subscribes to a resource, receives `notifications/resources/updated`, and re-reads the updated content
- Structured machine-parseable output: `route`, `subscribed`, `notification-received`, `unsubscribed`, `error-code`, `phase-summary`
- `--auth-token` / `MCP_PROBE_AUTH_TOKEN` for Bearer token auth (e.g. `copilot-review-mcp`)
- `--skip-resource-list-check` / `MCP_PROBE_SKIP_LIST_CHECK` for servers with dynamic resources not in `resources/list`
- `--timeout-ms` / `MCP_PROBE_TIMEOUT_MS` configurable notification wait (default: 15 s)
- `--version` / `--help` flags
- Bundled reference MCP test server (`test://review/status`) for reproducible client compatibility testing
- GitHub Actions publish workflow: triggers on `v*` tag push; runs build → typecheck → test → `npm publish`
- `workflow_dispatch` manual trigger for dry-run verification
- E2E test suite (`test/e2e.test.ts`) verifying Level 3 subscribe→notify→re-read flow against a live MCP server
- Compatibility matrix covering Codex CLI, Gemini CLI, OpenCode, GitHub Copilot CLI, Claude Code, Goose, Crush

### Notes

- `src/server/mcpServer.ts` and `src/client/probeClient.ts` contain hardcoded version strings. These must be updated manually on each version bump until dynamic `package.json` reading is added.

[0.1.2]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/scottlz0310/mcp-resource-subscriber/releases/tag/v0.1.0
