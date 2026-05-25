---
name: pr-review-subscribe
description: PR review completion and autonomous review-thread handling. Supports two routes: (1) Copilot review via MCP resource subscription (primary when copilot-review MCP is available), (2) Human review mode via GitHub REST/GraphQL when copilot-review MCP is unavailable. Use immediately after creating a PR, requesting Copilot review, after a human reviewer posts review threads, or when the user asks to process PR review comments. Never merge autonomously.
---

# pr-review-subscribe

Run the PR review cycle. Two routes are supported:

- **Copilot route** (when `{CRM}` tools are available): MCP resource subscription as the primary completion signal.
- **Human review route** (when `{CRM}` tools are unavailable): GitHub REST/GraphQL API for thread retrieval and resolution.

```text
Copilot primary:   start watch -> subscribe to watch resource -> wait for notifications/resources/updated -> read resource
Copilot fallback:  start watch -> poll get_copilot_review_watch_status
Human review:      wait for reviewer to submit (polling or user signal) -> read threads via GitHub API -> classify -> fix -> reply/resolve
```

If server/tool names differ, load `references/tool-template.md` and map placeholders before starting.

## Required Surfaces

| Placeholder | Purpose | Route |
| --- | --- | --- |
| `{CRM}` | Copilot review MCP tools: review status, request, watch start/cancel, threads, replies, cycle status | Copilot only |
| `{GH}` | GitHub issue/PR comment tools | Both |
| `{RSRC}` | MCP resource operations: list/read/subscribe/unsubscribe or an SDK/protocol client wrapper | Copilot only |

**Copilot route** minimum required operations:

- `{CRM}:get_copilot_review_status`
- `{CRM}:request_copilot_review`
- `{CRM}:start_copilot_review_watch`
- `{CRM}:cancel_copilot_review_watch`
- `{CRM}:get_review_threads`
- `{CRM}:reply_and_resolve_review_thread`
- `{CRM}:get_pr_review_cycle_status`
- `{GH}:add_issue_comment`
- `{GH}:create_issue` (required for Phase 5 scope-out / deferred reject follow-up tracking)
- `{RSRC}:resources/subscribe` equivalent for the watch resource
- `{RSRC}:resources/read` equivalent for the watch resource
- `{RSRC}:resources/unsubscribe` equivalent for the watch resource

Copilot fallback-only operation:

- `{CRM}:get_copilot_review_watch_status`

**Human review route** minimum required operations:

- `gh` CLI (for `gh api` GraphQL and REST calls)
- `{GH}:add_reply_to_pull_request_comment` (for thread replies)
- `{GH}:add_issue_comment` (for PR summary comment)
- `{GH}:create_issue` (for follow-up issue tracking)

## Flow

```text
Phase 0 -> CRM available? --(yes)--> Phase 1S -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5 -> Phase 6
                                          ^                                        | WAIT / REQUEST_REREVIEW
                                          |                                        v
                                          +----------------------------------------+
                                                   READY_TO_MERGE -> Phase 6.5 -> Phase 6.6 -> Phase 7 -> Phase 8

           CRM available? --(no)---> Phase H1 -> Phase H2 -> Phase 3 -> Phase 4 -> Phase H5 -> Phase H6
                                                                                              |
                                                                                              v
                                                                         READY_TO_MERGE -> Phase 6.5 -> Phase 6.6 -> Phase 7 -> Phase 8

Phase 1S detail (Copilot route):
  1S-A: Start Watch
  1S-B: Native resources/subscribe  --> success: wait for notification
         |
         | unavailable or failed
         v
  1S-B2: SDK Wrapper subscription   --> success: run wrapper, wait for output
         |
         | not found or failed
         v
  1S-C: Fallback Polling            (last resort only)
```

## Phase 0: Snapshot

1. Determine `owner`, `repo`, and `pr`.
2. **Check CRM availability**: Verify that `{CRM}` tools (e.g., `mcp__copilot-review__*`) are present in the current session's available tool list.
   - If unavailable: switch to **Human Review Mode** and go to **Phase H1**.
   - If available: continue to step 2a.
2a. **Check for Human Review Mode**: Switch to **Human Review Mode** (Phase H1) if any of the following are true:
   - The user explicitly invoked the skill with a `human-review` argument or requested processing of a human reviewer's comments.
   - A human reviewer has already posted review threads that need to be addressed (detected via `gh pr view --json latestReviews` showing `COMMENTED` / `CHANGES_REQUESTED` from a non-Copilot account).
   - Otherwise: proceed with Copilot route (steps 3–6 below).
3. Call `{CRM}:get_copilot_review_status`.
4. If `status = COMPLETED` or `BLOCKED`, go to Phase 2.
5. If `status = NOT_REQUESTED`, call `{CRM}:request_copilot_review`, then go to Phase 1S.
6. If `status = PENDING` or `IN_PROGRESS`, go to Phase 1S.

## Phase 1S: Subscribe And Wait

Record the Phase 1S start time. Reset the 15-minute timeout every time Phase 6 loops back here.

### 1S-A: Start Watch

Call `{CRM}:start_copilot_review_watch`.

Record:

- `watch_id`
- `resource_uri`
- `recommended_next_action`
- `next_poll_seconds`

If the response lacks `resource_uri`, construct it from the configured template in `references/tool-template.md`. If no reliable resource URI can be obtained, use fallback polling.

### 1S-B: Subscribe To Watch Resource (Native)

Attempt native subscription first:

1. Use `{RSRC}:resources/subscribe` on `resource_uri`.
2. **Immediately** call `{RSRC}:resources/read` for `resource_uri` once (no delay, no polling).
   If the result already shows a terminal state (e.g., `recommended_next_action=READ_REVIEW_THREADS`),
   proceed to Phase 2 **without waiting for a notification**.
   This handles the race condition where Copilot completed the review before the subscription
   was established and the `notifications/resources/updated` was already sent.
3. If the post-subscribe read is non-terminal, wait for `notifications/resources/updated` for that same `resource_uri`.
4. After every update notification, call `{RSRC}:resources/read` for `resource_uri`.
5. Parse the read content and follow `recommended_next_action`.

Expected terminal update:

```text
review_status=COMPLETED or BLOCKED
recommended_next_action=READ_REVIEW_THREADS
```

Action table:

| recommended_next_action | Next step |
| --- | --- |
| `READ_REVIEW_THREADS` | Phase 2 |
| `POLL_AFTER` | Keep the subscription open and wait for the next update |
| `CHECK_FAILURE` | Report the error and stop |
| `REAUTH_AND_START_NEW_WATCH` | Ask the user to re-authenticate and stop |
| `START_NEW_WATCH` | Unsubscribe if needed, then return to Phase 1S-A |

Do not poll while subscription is healthy. A periodic read without a notification is allowed only as a liveness check after a long quiet period, not as the main signal.

If native `{RSRC}:resources/subscribe` is unavailable or fails, go to **1S-B2** before falling back to polling.

### 1S-B2: SDK Wrapper Subscription

**Check for an SDK wrapper before falling back to polling.** This step is mandatory when native subscription is unavailable.

Look for a project-provided MCP subscription wrapper by inspecting the repository:

1. Check `package.json` scripts for entries like `probe:subscribe`, `subscribe-client`, or similar.
2. Check `scripts/` or `bin/` directories for a Node.js or other runtime MCP client.
3. Check `AGENTS.md`, `README.md`, or `docs/` for documented SDK wrapper commands.

If a wrapper is found and shell execution is allowed:

1. Identify the MCP server URL (from env, config, or a running Docker Compose service).
2. Run the wrapper with the `resource_uri` from 1S-A. Example pattern from `references/tool-template.md`:

```bash
pnpm dlx mcp-resource-subscriber --url <mcp-server-url> --uri <resource_uri> --timeout-ms 900000
```

If `pnpm` is unavailable, substitute `npx`:

```bash
npx mcp-resource-subscriber --url <mcp-server-url> --uri <resource_uri> --timeout-ms 900000
```

For servers requiring Bearer auth and dynamic resource URIs (e.g., `copilot-review-mcp`):

```bash
MCP_PROBE_AUTH_TOKEN=$(gh auth token) \
pnpm dlx mcp-resource-subscriber \
  --url <mcp-server-url> \
  --uri <resource_uri> \
  --skip-resource-list-check \
  --timeout-ms 900000
```

> **Note — version pinning**: `pnpm dlx` / `npx` default to the latest published version.
> Pin a specific release with `mcp-resource-subscriber@<version>` to ensure reproducibility.
> When testing unreleased local changes, use `node dist/src/client/cli.js` instead
> (requires `npm ci && npm run build` first).

3. The wrapper must:
   - Connect to the MCP server
   - Subscribe to `resource_uri`
   - **Immediately read the resource once after subscribing**; if terminal state is already
     present (e.g., `recommended_next_action=READ_REVIEW_THREADS`), complete with
     `route pre-completion` without waiting for a notification.
     This handles the race where Copilot finished before the probe subscribed.
   - Otherwise block until `notifications/resources/updated` is received
   - 通知ごとに resource を再読込する
   - `recommended_next_action=POLL_AFTER` の場合は同じ subscription を維持し、次の通知を待つ
   - 非 `POLL_AFTER` action、timeout、error のいずれかに到達してから return する
4. Parse the output and follow the same action table as 1S-B. wrapper の `exit 0` は transport 成功としてのみ扱う。final block が `recommended_next_action=READ_REVIEW_THREADS` の場合だけ Phase 2 に進む。

Report the route as `sdk-wrapper subscription route` in the final summary.

**Do not skip to fallback polling without first attempting 1S-B2** when shell access is available.

Proceed to 1S-C only if:

- No SDK wrapper is found in the repository.
- Shell execution is not permitted.
- The SDK wrapper fails to connect or exits with an error.

### 1S-C: Fallback Polling

Use fallback polling only if **all of the following are true**:

- The client exposes no `resources/subscribe` route (1S-B failed or was unavailable).
- No SDK wrapper was found or executable (1S-B2 failed or was unavailable).
- No `resource_uri` is available, or the subscription times out.

Fallback loop:

1. Wait `next_poll_seconds` from the latest response.
2. Call `{CRM}:get_copilot_review_watch_status`.
3. Follow its `recommended_next_action` using the same action table.

Label the final report clearly as `native subscription route`, `sdk-wrapper subscription route`, or `fallback polling route`.

### 1S-D: Timeout

If Phase 1S exceeds 15 minutes:

1. Call `{CRM}:cancel_copilot_review_watch`.
2. Add a PR comment through `{GH}:add_issue_comment`:

```text
Copilot review completion wait timed out after 15 minutes. Please resume manually.
```

3. Report the timeout to the user and stop.

### 1S-E: Subscription Cleanup

If `{RSRC}:resources/subscribe` succeeded, call `{RSRC}:resources/unsubscribe`
for `resource_uri` before leaving Phase 1S.

Unsubscribe before:

- entering Phase 2
- switching to fallback polling
- returning to Phase 1S-A with `START_NEW_WATCH`
- stopping due to `CHECK_FAILURE`
- stopping due to timeout
- stopping due to user cancellation

If unsubscribe fails, report it, but continue the review cycle if the watch has
already reached a terminal state.

---

## Human Review Mode (Phase H1 – H6)

These phases apply when `{CRM}` tools are unavailable (e.g., copilot-review MCP not running).
The reviewer is a human using an external tool (another GitHub account, ChatGPT with GitHub integration, etc.).
Thread retrieval and resolution use GitHub REST and GraphQL APIs via `gh`.

### Phase H1: Wait For Review

1. Run:
   ```bash
   gh pr view <pr> --repo <owner>/<repo> --json reviews,latestReviews
   ```
2. If a review with `state = COMMENTED | CHANGES_REQUESTED | APPROVED` exists from any account, proceed to Phase H2.
3. If no review exists yet:
   - Report: "No review found yet. Please let me know when a review has been submitted (or type `resume` to re-check)."
   - Stop and wait for user signal. Do not poll automatically — human review timing is unpredictable.

When the user signals that a review has been posted, re-enter at Phase H1.

### Phase H2: Read Threads (Human Review Mode)

Retrieve unresolved inline threads via GraphQL:

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 10) {
              nodes {
                databaseId
                body
                path
                line
                author { login }
                createdAt
              }
            }
          }
        }
      }
    }
  }
' -f owner=<owner> -f repo=<repo> -F pr=<pr>
```

- If `pageInfo.hasNextPage` is `true`, repeat the query with `-f cursor=<endCursor>` until `hasNextPage = false`. Collect all nodes across pages before proceeding.
- Collect threads where `isResolved = false`.
- Record each thread's `id` (GraphQL node ID — treat as opaque; observed format is `PRRT_...` — used for resolve mutation) and the root comment's `databaseId` (used for replies).
- If 0 unresolved threads: proceed to Phase 6.5 (same as Phase 2 routing on 0 threads).
- Otherwise: proceed to Phase 3.

Route label for Phase 7 report: `human-review route`.

### Phase H5: Reply And Resolve (Human Review Mode)

For every reviewed thread:

**Reply** using `{GH}:add_reply_to_pull_request_comment` (map to the actual operation name via `references/tool-template.md` — e.g. `reply_to_review_comment` in some MCP servers):
- `owner`, `repo`, `pull_number`: as determined in Phase 0
- `comment_id`: the root comment's `databaseId` from Phase H2
- `body`: reply text (same content rules as Phase 5)

**Resolve** using GraphQL mutation via `gh api graphql`:
```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { id isResolved }
    }
  }
' -f threadId=<PRRT_node_id>
```

- Apply the same fixed / rejected reply rules as Phase 5 (scope-out requires follow-up issue, etc.).
- Set resolve only when the reply has been confirmed sent. If `gh api graphql` returns an error, report it and continue to the next thread without silently skipping.

### Phase H6: Cycle Status (Human Review Mode)

Re-run the Phase H2 query to count remaining unresolved threads.

- unresolved = 0 → `READY_TO_MERGE`; proceed to Phase 6.5.
- unresolved > 0 → Report the remaining items to the user. Ask whether to request a re-review from the human reviewer or to defer.
  Do NOT loop back automatically — human re-review requires the reviewer to act.

---

## Phase 2: Read Threads

Call `{CRM}:get_review_threads`.

**Routing on 0 unresolved threads** (both cases → Phase 6.5):

- `cycles_done = 0` and unresolved = 0: Copilot found no issues on first review.
- `cycles_done ≥ 1` and unresolved = 0: Re-review completed with no new issues; all previous fixes were approved.

> **Issue #36 fix**: the original skill lacked the second branch. Without it the agent
> entered Phase 3–5 with nothing to do and then Phase 6, which returned
> `REQUEST_REREVIEW` again until `ESCALATE`. When unresolved = 0 on any cycle,
> always skip directly to Phase 6.5.

Otherwise (unresolved > 0), proceed to Phase 3.

## Phase 3: Classify And Decide

Classify each unresolved comment:

| Class | Criteria |
| --- | --- |
| `blocking` | Runtime failure, data corruption, security risk, broken behavior, inconsistent published record |
| `non-blocking` | Useful quality, logging, test, privacy, or consistency improvement |
| `suggestion` | Naming, structure, style, or maintainability suggestion |

Decide `accept` or `reject` autonomously. Reject only with a concrete reason such as out of scope, already handled, invalid premise, or intentionally deferred.

**Reject constraint — scope-out / deferred requires tracking issue.**
A reject whose reason is `out-of-scope`, `deferred`, or `follow-up` (i.e., the item is acknowledged as valid but will be handled later) is NOT complete until it is traceable to a follow-up issue. For these reject reasons, the `Follow-up issue` column below MUST be filled with a valid issue number that actually covers the item. See Phase 5 for issue creation / linking rules.

Reject reasons that do NOT require a follow-up issue:

- `already-handled` — the item is already addressed in this PR or elsewhere; cite the commit / PR / issue.
- `invalid-premise` — the comment is based on a misunderstanding; explain why.
- `wont-fix` — an explicit decision not to address it; explain why. Must NOT say "will handle later" or "deferred to another issue".

Show this table before editing:

```text
| # | Thread ID | Class | Decision | Summary | Reject reason | Follow-up issue |
|---|-----------|-------|----------|---------|---------------|-----------------|
```

`Follow-up issue` column rules:

- `accept` rows: leave blank or `N/A`.
- `reject` rows with reason `out-of-scope` / `deferred` / `follow-up`: MUST contain `#<number>` of an issue that actually covers the item. Blank or `TBD` is not allowed at this stage — defer Phase 5 instead (see Phase 5 step 4).
- `reject` rows with reason `already-handled` / `invalid-premise` / `wont-fix`: leave blank or `N/A`.

Choose `fix_type` for Phase 6:

| fix_type | Use for |
| --- | --- |
| `logic` | Code behavior or tests |
| `spec_change` | Public docs, API, workflow, or compatibility record semantics |
| `trivial` | Typo, formatting, wording-only, or table-shape fix |
| `none` | No accepted changes |

## Phase 4: Fix And Commit

1. Run `git status --short --branch`.
2. Fix only accepted items.
3. Keep changes atomic by review thread unless a shared edit is clearly cleaner.
4. Run relevant build/tests/checks.
5. Commit once after the cycle's fixes using Conventional Commits.
6. Push without force unless the user explicitly asks otherwise.

Do not revert unrelated user changes.

## Phase 5: Reply And Resolve

For every reviewed thread, call `{CRM}:reply_and_resolve_review_thread`.

- Fixed: mention the commit and concrete fix.
- Rejected: explain the reason. See the reject sub-rules below.
- Always set `resolve=true` unless the tool or platform prevents resolution, or unless step 4 below requires the thread to stay open.

### Reject reply rules

A scope-out reject is not complete until it is traceable. If the reply says the item will be handled later, the reply MUST include a valid follow-up issue number that actually covers that item. Do not resolve the thread with a vague "out of scope" or "will handle later" statement without creating or linking the tracking issue.

#### 1. Linking an existing issue

When an existing issue already covers the item:

- Include `Tracked by #xxx` or `Follow-up: #xxx` in the reply body.
- Confirm the linked issue's title / description actually covers the rejected comment's substance. Do NOT reuse an issue that was opened for a different purpose just because it touches the same file or component.
  - Bad example: linking a "show latest-version banner" issue as the follow-up for a "missing tests" or "accessibility" comment.
- If no existing issue covers the item, go to step 2 instead.

#### 2. Creating a new follow-up issue

When no existing issue covers the item, create one before (or within the same Phase 5 as) resolving the thread:

1. Call `{GH}:create_issue` with a title and body that clearly describe the deferred work and reference the originating PR / thread.
2. Capture the new issue number.
3. Include `Follow-up: #<new-number>` in the reply.
4. Record the issue number in the Phase 3 decision table (`Follow-up issue` column) and carry it into the Phase 7 Summary `Deferred / Scope-out Items` list.

#### 3. Explicit `Won't fix`

If the decision is to truly not address the item:

- Reply with `Won't fix` and a concrete reason (e.g., "conflicts with intended behavior", "out of project scope", "would regress X").
- Do NOT write phrases like "will handle later", "deferred to another issue", or "follow-up coming" — those imply tracked work and require step 1 or 2 instead.

#### 4. When issue creation or linking is not possible

If a follow-up issue cannot be created or confirmed in this cycle (tool unavailable, permission denied, ambiguity about which issue covers the item, etc.):

- Do NOT resolve the thread. Leave `resolve=false` and reply that the thread is awaiting a tracking issue, or stop with `needs user decision`.
- Record the unresolved item explicitly in the Phase 7 Summary `Deferred / Scope-out Items` section as `untracked — needs follow-up issue` so it is not silently dropped.

## Phase 6: Cycle Status

Call `{CRM}:get_pr_review_cycle_status`:

```json
{
  "owner": "<owner>",
  "repo": "<repo>",
  "pr": 42,
  "cycles_done": 0,
  "max_cycles": 0,
  "fix_type": "<fix_type>"
}
```

> `max_cycles: 0` means "use the server-side default".
> It must not be interpreted as unlimited retries.
> The default is controlled by `MAX_REVIEW_CYCLES` and is 3 if unset.

Follow `recommended_action`:

| Action | Next step |
| --- | --- |
| `WAIT` | Increment `cycles_done`, return to Phase 1S |
| `REPLY_RESOLVE` | Return to Phase 2 |
| `REQUEST_REREVIEW` | See override rule below; otherwise call `{CRM}:request_copilot_review`, increment `cycles_done`, return to Phase 1S |
| `READY_TO_MERGE` | Phase 6.5 |
| `ESCALATE` | Classify and report (see termination classification below), then stop |

**`REQUEST_REREVIEW` override (Issue #36)**:
If `recommended_action = REQUEST_REREVIEW` AND the just-completed review returned 0 new unresolved threads, do **not** request another review. The tool's cycle accounting does not have enough context to detect this; the agent must apply this judgment override.

Treat the situation as `READY_TO_MERGE` and proceed to Phase 6.5.

This override applies when both are true:
- `cycles_done ≥ 1` (this is not the first cycle)
- unresolved thread count from Phase 2 of this cycle = 0

**Termination classification (Issue #36 follow-up)**:

When the cycle terminates, classify the outcome so Phase 7 / Phase 8 can communicate
the right level of confidence:

| Classification | Condition | Implication for merge |
| --- | --- | --- |
| ✅ `READY_TO_MERGE` | `recommended_action = READY_TO_MERGE`, or override applied with `unresolved = 0` | Safe — normal merge gate |
| 🟡 `ESCALATE — Clean` | `recommended_action = ESCALATE` AND the final cycle's accepted fixes contain **no** `blocking` items (only `non-blocking` / `suggestion` / `trivial`, or no fix at all) | Likely safe — note the unverified status but no blocking risk |
| 🔴 `ESCALATE — Unverified Fix` | `recommended_action = ESCALATE` AND the final cycle accepted **at least one `blocking` fix** that Copilot has not re-reviewed | Risky — recommend human review of the last commit before merge |

The classification uses the **final cycle's** Phase 3 decision table:

- Count `accept` decisions where Class = `blocking` (from the final cycle only).
- If that count ≥ 1 and the final action is `ESCALATE`, classify as `ESCALATE — Unverified Fix`.
- Otherwise on `ESCALATE`, classify as `ESCALATE — Clean`.

Record the following for Phase 7:

- `termination_status`: one of the three values above
- `final_cycle_fix_types`: counts of `blocking` / `non-blocking` / `suggestion` / `trivial` accepts
- `override_applied`: `yes` if the Issue #36 override was used to reach `READY_TO_MERGE`, otherwise `no`
- `unverified_blocking_commits`: list of commit SHAs from the final cycle when classification is `ESCALATE — Unverified Fix`

On `ESCALATE — Unverified Fix`, still proceed to Phase 6.5 / 6.6 / 7 (CI and summary
are still useful), but Phase 8 must downgrade merge readiness regardless of CI outcome.

## Phase 6.5: CI

1. Run `gh pr checks <pr>`.
2. If all checks pass, continue to Phase 6.6.
3. If checks fail, inspect failed logs with `gh run view <run-id> --log-failed`.
4. If the failure is fixable, add it to the accepted work and return to Phase 4.
5. If it is not fixable, report and stop.

If `gh` is unavailable, unauthenticated, or cannot access the PR checks,
use the available `{GH}` / GitHub MCP server route to inspect check runs or PR status.

If neither route can verify CI, report `CI: unknown` and stop before Phase 7
instead of claiming readiness.

## Phase 6.6: Coverage

Check Codecov or similar PR comments if present.

- If testable coverage gaps are introduced, return to Phase 4 with `fix_type=logic`.
- If no relevant coverage signal exists or there is no issue, continue to Phase 7.

## Phase 7: Summary Comment

Post a PR comment through `{GH}:add_issue_comment`:

```markdown
## Review Cycle Summary

### Route
- Mode: copilot-review route | human-review route
- Completion wait: native subscription route | sdk-wrapper subscription route | fallback polling route | human-review (user-signaled)
- Watch resource: <resource_uri or N/A>
- Watch ID: <watch_id or N/A>
- Notification received: yes | no | N/A
- Post-notification read: terminal | non-terminal | N/A
- Unsubscribed: yes | no | N/A
- Reviewer account: <login or "Copilot"> (human-review route only)

### Changes
- ...

### Decisions
- accept: N
- reject: M

### Remaining Items
- None | ...

### Deferred / Scope-out Items
- None | <list of follow-up issues>

### Verification
- CI: ...
- Unresolved threads: ...
- Cycle status: <termination_status>
  - one of: `READY_TO_MERGE` | `ESCALATE — Clean` | `ESCALATE — Unverified Fix`
  - On `ESCALATE — Unverified Fix`: include reason, the unverified commit SHA(s),
    and an explicit "Recommendation: human review of the last commit before merge".
- Final cycle fix types: blocking × N, non-blocking × N, suggestion × N, trivial × N
- Override applied (Issue #36): yes | no
```

Example for `ESCALATE — Unverified Fix`:

```markdown
### Verification
- CI: ✅
- Unresolved threads: 0
- Cycle status: 🔴 ESCALATE — Unverified Fix
  - Reason: max_cycles (3) reached; final cycle accepted a blocking fix
    (<commit-sha>) that Copilot has not re-reviewed
  - Final cycle fix types: blocking × 1
  - Recommendation: human review of the last commit before merge
- Override applied (Issue #36): no
```

### Deferred / Scope-out Items rules

This section MUST list every reject whose reason was `out-of-scope`, `deferred`, or `follow-up` from this cycle, with the follow-up issue number and a one-line summary:

```markdown
### Deferred / Scope-out Items
- #238 — Add tests for file distribution Supabase operations and W6 dialog
- #239 — Improve accessibility for file distribution status and download buttons
```

`- None` is only allowed when **all** of the following are true:

- No reject in the final Phase 3 decision table used reason `out-of-scope` / `deferred` / `follow-up`.
- No thread was left unresolved due to Phase 5 step 4 (`untracked — needs follow-up issue`).

If any item was left untracked, list it explicitly so it is not silently dropped:

```markdown
### Deferred / Scope-out Items
- Thread <id> — untracked — needs follow-up issue (Phase 5 step 4)
```

`Won't fix` rejects do NOT go in this section — they were decided final and need no follow-up.

## Phase 8: Merge Gate

Never merge autonomously.

Before any user-requested merge, verify:

- CI all success
- unresolved review threads = 0
- all threads replied
- no unresolved blocking item
- `termination_status` is `READY_TO_MERGE` or `ESCALATE — Clean`

If `termination_status` is `🔴 ESCALATE — Unverified Fix`:

1. Do **not** report the PR as ready to merge, even if CI is green and unresolved = 0.
2. Surface the warning prominently to the user with the unverified commit SHA(s).
3. If the user still requests a merge, confirm explicitly that they have manually
   reviewed the unverified blocking fix before proceeding.

If any other condition is missing, report it instead of merging.

## Reporting Requirements

In the final response, include:

- PR URL
- **mode**: `copilot-review route` or `human-review route`
- which route was used: native subscription, sdk-wrapper subscription, fallback polling, or human-review (user-signaled)
- `resource_uri` and `watch_id` when available (copilot-review route only)
- reviewer account login(s) (human-review route)
- commits pushed
- CI status
- unresolved thread count
- for copilot-review route — subscription evidence:
  - whether `{RSRC}:resources/subscribe` was actually used
  - whether `notifications/resources/updated` was received
  - whether `{RSRC}:resources/read` after notification reached a terminal watch state
  - whether `{RSRC}:resources/unsubscribe` completed
- for human-review route — resolution evidence:
  - number of threads replied via `{GH}:add_reply_to_pull_request_comment`
  - number of threads resolved via `gh api graphql resolveReviewThread`
  - any threads left unresolved (with reason)
- merge readiness
- `termination_status` (`READY_TO_MERGE` / `ESCALATE — Clean` / `ESCALATE — Unverified Fix`)
- on `ESCALATE — Unverified Fix`: the unverified blocking commit SHA(s) and an explicit human-review recommendation

## Environment Notes: copilot-review-mcp (Confirmed 2026-05-14)

These notes apply when the Copilot review MCP server is `copilot-review-mcp` accessed via
`mcp-gateway`. They were confirmed by Issue #43 Level 3 E2E test on PR #44.

### Gateway URL

```
http://127.0.0.1:8080/mcp/copilot-review
```

`mcp-gateway` must be running. Verify with `curl -s http://127.0.0.1:8080/health` or
check the process list.

### Authentication

All requests require a valid GitHub OAuth Bearer token:

```bash
Authorization: Bearer $(gh auth token)
```

If the token expires mid-session, `mcp-gateway` returns `REAUTH_REQUIRED`. Run
`gh auth login` to refresh.

### Resource URI Format

Watch resources use dynamic URIs that appear in `resources/list` only while the watch is active, but may not be listed immediately after starting:

```
copilot-review://watch/<watch_id>
```

`watch_id` is returned by `start_copilot_review_watch`. Always pass
`--skip-resource-list-check` (or `MCP_PROBE_SKIP_LIST_CHECK=true`) when using
the probe CLI.

### Confirmed Working Route: SDK Wrapper Subscription (Phase 1S-B2)

The copilot-review-mcp gateway **does support** the MCP `resources/subscribe` +
`notifications/resources/updated` protocol. The confirmed SDK wrapper command:

```bash
# Using env var (recommended — avoids token in process list)
MCP_PROBE_AUTH_TOKEN=$(gh auth token) \
pnpm dlx mcp-resource-subscriber \
  --url http://127.0.0.1:8080/mcp/copilot-review \
  --uri copilot-review://watch/<watch_id> \
  --skip-resource-list-check \
  --timeout-ms 900000
```

If `pnpm` is unavailable, substitute `npx` for `pnpm dlx`.

Or via vitest E2E (useful for assertion logging):

```bash
MCP_E2E_URL=http://127.0.0.1:8080/mcp/copilot-review \
MCP_E2E_TOKEN=$(gh auth token) \
MCP_E2E_WATCH_ID=<watch_id> \
pnpm dlx vitest run test/e2e.test.ts
```

### Confirmed Successful Output (Level 3, ~84s)

Normal subscription route (notification received after review completes):

```
route subscription
subscribed true
notification-received true
unsubscribed true
error-code null
```

Pre-completion route (review already done before probe subscribed — race condition):

```
route pre-completion
subscribed true
notification-received false
unsubscribed true
error-code null
```

Both outputs are valid success results. Parse `recommended_next_action` from the `final` block to determine the next phase.

### Subscription Probe Timeout

Copilot reviews take up to ~15 minutes. Use `--timeout-ms 900000` (15 min).
The Level 3 test saw notification in ~84 seconds; your timing will vary.

### `skipResourceListCheck` Requirement

Watch URIs appear in `resources/list` only while the watch is active, but
there is a timing window where the URI may not be listed immediately after
`start_copilot_review_watch` returns. The probe client's
`skipResourceListCheck: true` option skips the list check and attempts
subscription directly. Without this flag, the probe may exit with
`RESOURCE_NOT_FOUND` if the watch has not yet been reflected in the list.
