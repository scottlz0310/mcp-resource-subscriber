# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-09

### Added

- `--json` 出力モードを追加（#87 / #86）
  - `--json` フラグを指定すると、単一の JSON オブジェクトを stdout に出力し、診断メッセージは stderr のみに書き出す
  - `JsonOutput` 型: `{ route, serverUrl, resourceUri, subscribed, notificationReceived, notificationCount, unsubscribed, errorCode, initialText, finalText, recommendedNextAction }`
  - 成功時 exit 0、エラー時 exit 1（`errorCode` フィールドに `SERVER_URL_UNKNOWN` / `NOTIFICATION_TIMEOUT` / `INTERNAL_ERROR` 等を反映）
  - malformed な引数（`--uri` 値なし、`--timeout-ms bad` 等）でも stdout に valid JSON を出力し、スタックトレースを抑止
  - `src/client/jsonOutput.ts` にトランスフォーム関数（`buildJsonOutput` / `buildErrorJsonOutput`）を副作用なしモジュールとして分離

### Internal

- `test/cli.test.ts` を追加: CLI を子プロセスとして起動し stdout / stderr / exit code を直接検証（8 ケース）
- CLI サブプロセステストを `node --import tsx/esm` でソース直接起動に変更し、fresh checkout での `pnpm test` 単独実行を保証

## [0.1.4] - 2026-05-29

### Changed

- リポジトリの package manager を npm から pnpm に移行
  - `packageManager` で `pnpm@11.4.0` を固定
  - `package-lock.json` を削除し、`pnpm-lock.yaml` を唯一の lockfile として採用
  - CI / Docker / lefthook / README / AGENTS.md の実行コマンドを pnpm 前提に更新
- `pr-review-subscribe` skill: `Copilot route / Human Review Mode` の二分法を廃止し、provider 抽象化 + Unified Review Thread Handling に再設計（#67）
  - `provider = auto | copilot-review | codex | external | existing` を Phase 0 で選択
  - Phase H1–H6 を廃止し、provider 非依存の Phase U1–U6 (Unified Review Thread Handling) に置き換え
  - Phase 2/5/6 (CRM-based thread handling) を廃止し、すべての provider で `gh api graphql` による統一スレッド処理を使用
  - Phase 1S は copilot-review 取得専用として維持
  - Phase W を新設: codex (`@codex review` コメント投稿) / external / human (ユーザー signal 待ち) に対応
  - Phase U6 に re-review policy を実装: copilot-review → structured ループ (max cycles)、その他 → message-based (`WAITING_FOR_REVIEW`) で停止
  - `termination_status` に `WAITING_FOR_REVIEW(provider=...)` を追加
  - Phase 7 Summary に `acquisition provider`・`re-review mode`・`re-review status`・`cycles done` フィールドを追加
  - Phase 8 Merge Gate に `WAITING_FOR_REVIEW` 状態のチェックを追加
- `pr-review-subscribe` skill: Phase U6 に `need_re_review` 判定を追加（PR #68 レビュー指摘対応）
  - `unresolved = 0` だけで READY_TO_MERGE に進まず、`fix_type` と `blocking` accept の有無で `need_re_review` を判定
  - `fix_type = logic | spec_change` または `blocking` accept が 1 件以上あれば re-review を要求
  - `fix_type = none | trivial` の場合のみ即 READY_TO_MERGE
  - Issue #36 override を「`need_re_review = no` の場合のみ適用」と明確化

### Internal

- npm publish を Trusted Publishing (OIDC) に移行（`id-token: write` 追加、`NPM_TOKEN` 撤廃、`npm publish --provenance --access public` に統一）(#72)
- バージョン文字列を 0.1.4 に同期（`package.json` / `src/server/mcpServer.ts` / `src/client/probeClient.ts`）

## [0.1.3] - 2026-05-17

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

[Unreleased]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/scottlz0310/mcp-resource-subscriber/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/scottlz0310/mcp-resource-subscriber/releases/tag/v0.1.0
