---
name: pr-review-subscribe
description: PR review cycle with provider-agnostic Unified Review Thread Handling. Supports multiple acquisition providers — copilot-review (MCP watch/subscribe), codex (@codex mention), external/human (user-signaled), or existing threads. Thread collection, classification, fixing, reply, and resolve are unified across all providers. Re-review uses structured loops for copilot-review and message-based requests for others. Use immediately after creating a PR, requesting any review, after a reviewer posts threads, or when the user asks to process PR review comments. Never merge autonomously.
---

# pr-review-subscribe

PR review cycle with **provider abstraction**: review acquisition and thread processing are separate concerns.

```text
provider = auto | copilot-review | codex | external | existing

Review acquisition (provider-specific):
  copilot-review → Phase 1S (watch/subscribe/complete)
  codex          → Phase W  (post @codex review comment, wait)
  external/human → Phase W  (wait for user signal)
  existing       → skip directly to Phase U1

Unified Review Thread Handling (all providers):
  Phase U1 → Phase U2 → Phase 3 → Phase 4 → Phase U5 → Phase U6
```

If server/tool names differ, load `references/tool-template.md` and map placeholders before starting.

## Required Surfaces

| Placeholder | Purpose | When used |
| --- | --- | --- |
| `{CRM}` | Copilot review MCP tools: review status, request, watch start/cancel | copilot-review acquisition only |
| `{GH}` | GitHub issue/PR comment tools | All providers |
| `{RSRC}` | MCP resource operations: subscribe/read/unsubscribe or SDK wrapper | copilot-review acquisition only |

**copilot-review acquisition** minimum operations:

- `{CRM}:get_copilot_review_status`
- `{CRM}:request_copilot_review`
- `{CRM}:start_copilot_review_watch`
- `{CRM}:cancel_copilot_review_watch`
- `{CRM}:get_copilot_review_watch_status` (fallback polling only)
- `{RSRC}:resources/subscribe` equivalent for the watch resource
- `{RSRC}:resources/read` equivalent for the watch resource
- `{RSRC}:resources/unsubscribe` equivalent for the watch resource

**Unified thread handling** minimum operations (all providers):

- `gh` CLI (for `gh api` GraphQL and REST calls)
- `{GH}:add_reply_to_pull_request_comment` (map actual name via `references/tool-template.md`)
- `{GH}:add_issue_comment` (for PR summary comment and re-review requests)
- `{GH}:create_issue` (for follow-up issue tracking)

## Flow

```text
Phase 0: provider selection
  |
  +--> existing threads detected --------> Phase U1
  |
  +--> copilot-review --> Phase 1S -------> Phase U1
  |
  +--> codex/external --> Phase W ---------> Phase U1 (on user signal)

Phase U1 -> Phase U2 -> Phase 3 -> Phase 4 -> Phase U5 -> Phase U6
                                                             |
                        READY_TO_MERGE <-------- unresolved=0
                             |
                   Phase 6.5 -> Phase 6.6 -> Phase 7 -> Phase 8

Phase U6 re-review policy:
  copilot-review  → structured: Phase 1S loop (max cycles)
  codex/external  → message-based: post comment → WAITING_FOR_REVIEW → stop
  (on ESCALATE or max cycles exceeded → Phase 6.5)

Phase 1S detail (copilot-review acquisition):
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

## Phase 0: Provider Selection

1. Determine `owner`, `repo`, and `pr`.
2. Determine `provider` using the following priority:

   **a. Explicit specification** (highest priority): if the user specified a provider (`copilot-review`, `codex`, `external`, `existing`), use it and jump to the corresponding step below.

   **b. Auto — existing threads detected**: run:
   ```bash
   gh pr view <pr> --repo <owner>/<repo> --json latestReviews
   ```
   If any entry has `state = COMMENTED | CHANGES_REQUESTED | APPROVED`, set `provider = existing` and go to **Phase U1**.

   **c. Auto — {CRM} available**: if `{CRM}` tools (e.g., `mcp__copilot-review__*`) are present in the session's available tool list, set `provider = copilot-review` and proceed to steps 3–6.

   **d. Auto — codex mentioned**: if the user's request mentions Codex or `@codex`, set `provider = codex` and go to **Phase W**.

   **e. Auto — fallback**: set `provider = external` and go to **Phase W**.

3. *(copilot-review only)* Call `{CRM}:get_copilot_review_status`.
4. If `status = COMPLETED` or `BLOCKED`, go to **Phase U1**.
5. If `status = NOT_REQUESTED`, call `{CRM}:request_copilot_review`, then go to **Phase 1S**.
6. If `status = PENDING` or `IN_PROGRESS`, go to **Phase 1S**.

## Phase W: Wait For Review (codex / external / human)

### codex

Post a review request comment via `{GH}:add_issue_comment`:

```markdown
@codex review

Please review the latest commit.
```

Report status `WAITING_FOR_REVIEW(provider=codex)` and stop. When the user signals that Codex has posted a review, re-enter at **Phase U1**.

### external / human

Report: "Waiting for reviewer. Please let me know when a review has been submitted (or type `resume` to re-check)."

Stop with status `WAITING_FOR_REVIEW(provider=external)`. When the user signals, re-enter at **Phase U1**.

Do not poll automatically — non-Copilot review timing is unpredictable.

## Phase 1S: Subscribe And Wait (copilot-review only)

Record the Phase 1S start time. Reset the 15-minute timeout every time Phase U6 loops back here.

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
   proceed to Phase U1 **without waiting for a notification**.
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
| `READ_REVIEW_THREADS` | Phase U1 |
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
4. Parse the output and follow the same action table as 1S-B. wrapper の `exit 0` は transport 成功としてのみ扱う。final block が `recommended_next_action=READ_REVIEW_THREADS` の場合だけ Phase U1 に進む。

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

- entering Phase U1
- switching to fallback polling
- returning to Phase 1S-A with `START_NEW_WATCH`
- stopping due to `CHECK_FAILURE`
- stopping due to timeout
- stopping due to user cancellation

If unsubscribe fails, report it, but continue the review cycle if the watch has
already reached a terminal state.

---

## Phase U1: Confirm Review Exists

Run:

```bash
gh pr view <pr> --repo <owner>/<repo> --json reviews,latestReviews
```

- If reviews exist (`state = COMMENTED | CHANGES_REQUESTED | APPROVED`): record reviewer logins and proceed to **Phase U2**.
- If no reviews found (unexpected after acquisition): report "No review found — returning to Phase 0" and return to Phase 0.

## Phase U2: Collect All Review Threads

Retrieve all review threads via paginated GraphQL:

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
- If 0 unresolved threads: proceed to **Phase 6.5**.
- Otherwise: proceed to **Phase 3**.

## Phase 3: Classify And Decide

Classify each unresolved comment:

| Class | Criteria |
| --- | --- |
| `blocking` | Runtime failure, data corruption, security risk, broken behavior, inconsistent published record |
| `non-blocking` | Useful quality, logging, test, privacy, or consistency improvement |
| `suggestion` | Naming, structure, style, or maintainability suggestion |

Decide `accept` or `reject` autonomously. Reject only with a concrete reason such as out of scope, already handled, invalid premise, or intentionally deferred.

**Reject constraint — scope-out / deferred requires tracking issue.**
A reject whose reason is `out-of-scope`, `deferred`, or `follow-up` (i.e., the item is acknowledged as valid but will be handled later) is NOT complete until it is traceable to a follow-up issue. For these reject reasons, the `Follow-up issue` column below MUST be filled with a valid issue number that actually covers the item. See Phase U5 for issue creation / linking rules.

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
- `reject` rows with reason `out-of-scope` / `deferred` / `follow-up`: MUST contain `#<number>` of an issue that actually covers the item. Blank or `TBD` is not allowed at this stage — defer Phase U5 instead (see Phase U5 step 4).
- `reject` rows with reason `already-handled` / `invalid-premise` / `wont-fix`: leave blank or `N/A`.

Choose `fix_type` for Phase U6:

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

## Phase U5: Reply And Resolve

For every reviewed thread:

**Reply** using `{GH}:add_reply_to_pull_request_comment` (map to the actual operation name via `references/tool-template.md` — e.g. `reply_to_review_comment` in some MCP servers):
- `owner`, `repo`, `pull_number`: as determined in Phase 0
- `comment_id`: the root comment's `databaseId` from Phase U2
- `body`: reply text (see reject sub-rules below)

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

- Fixed: mention the commit and concrete fix.
- Rejected: explain the reason. See the reject sub-rules below.
- Always set resolve (call the mutation) unless the tool returns an error, or step 4 below requires the thread to stay open.
- If `gh api graphql` returns an error, report it and continue to the next thread without silently skipping.

### Reject reply rules

A scope-out reject is not complete until it is traceable. If the reply says the item will be handled later, the reply MUST include a valid follow-up issue number that actually covers that item.

#### 1. Linking an existing issue

When an existing issue already covers the item:

- Include `Tracked by #xxx` or `Follow-up: #xxx` in the reply body.
- Confirm the linked issue's title / description actually covers the rejected comment's substance. Do NOT reuse an issue that was opened for a different purpose just because it touches the same file or component.
- If no existing issue covers the item, go to step 2 instead.

#### 2. Creating a new follow-up issue

When no existing issue covers the item, create one before (or within the same Phase U5 as) resolving the thread:

1. Call `{GH}:create_issue` with a title and body that clearly describe the deferred work and reference the originating PR / thread.
2. Capture the new issue number.
3. Include `Follow-up: #<new-number>` in the reply.
4. Record the issue number in the Phase 3 decision table (`Follow-up issue` column) and carry it into the Phase 7 Summary `Deferred / Scope-out Items` list.

#### 3. Explicit `Won't fix`

If the decision is to truly not address the item:

- Reply with `Won't fix` and a concrete reason (e.g., "conflicts with intended behavior", "out of project scope", "would regress X").
- Do NOT write phrases like "will handle later", "deferred to another issue", or "follow-up coming" — those imply tracked work and require step 1 or 2 instead.

#### 4. When issue creation or linking is not possible

If a follow-up issue cannot be created or confirmed in this cycle:

- Do NOT resolve the thread. Leave it open and reply that the thread is awaiting a tracking issue, or stop with `needs user decision`.
- Record the unresolved item explicitly in the Phase 7 Summary `Deferred / Scope-out Items` section as `untracked — needs follow-up issue` so it is not silently dropped.

## Phase U6: Cycle Status + Re-review Policy

Track `cycles_done` locally (starts at 0, increments each time a review cycle processes new threads). `max_cycles` default is 3.

**Step 1: Re-fetch unresolved threads** (re-run the Phase U2 query).

- If unresolved > 0: this is unexpected (Phase U5 should have resolved everything). Report remaining threads and stop with `needs user decision`.

**Step 2: Determine `need_re_review`** (only when unresolved = 0):

| fix_type from Phase 3 | Accepted `blocking` class? | need_re_review |
| --- | --- | --- |
| `none` | — | **no** |
| `trivial` | — | **no** |
| `logic` or `spec_change` | any | **yes** |
| any | at least 1 `blocking` accept | **yes** |

**Step 3: Route**

- `need_re_review = no` → proceed to **Phase 6.5** with `termination_status = READY_TO_MERGE`.

> **Issue #36 clarification**: "never re-review just because cycles_done < max_cycles" applies only
> when `need_re_review = no`. If `fix_type` is `logic` / `spec_change` or a `blocking` fix was
> accepted, requesting re-review is legitimate — the Issue #36 override does NOT suppress that.

- `need_re_review = yes` AND `cycles_done ≥ max_cycles` → classify termination and proceed to **Phase 6.5**.

- `need_re_review = yes` AND `cycles_done < max_cycles` → choose re-review approach by `provider`:

**If unresolved threads > 0** (should not occur after Phase U5): stop with `needs user decision` — do not proceed to re-review routing below.

### Structured re-review (copilot-review)

If `cycles_done < max_cycles`:
1. Call `{CRM}:request_copilot_review`.
2. Increment `cycles_done`.
3. Return to **Phase 1S**.

If `cycles_done ≥ max_cycles`: classify termination and proceed to **Phase 6.5**.

**Termination classification:**

| Classification | Condition | Merge implication |
| --- | --- | --- |
| ✅ `READY_TO_MERGE` | unresolved = 0 (any cycle) | Safe — normal merge gate |
| 🟡 `ESCALATE — Clean` | max cycles AND final cycle has **no** `blocking` accepts | Likely safe — note unverified status |
| 🔴 `ESCALATE — Unverified Fix` | max cycles AND final cycle accepted **≥ 1 `blocking` fix** not re-reviewed | Risky — recommend human review of last commit |

Record for Phase 7:
- `termination_status`
- `final_cycle_fix_types`: counts of `blocking` / `non-blocking` / `suggestion` / `trivial` accepts
- `unverified_blocking_commits`: commit SHAs when classification is `ESCALATE — Unverified Fix`

On `ESCALATE — Unverified Fix`, still proceed to Phase 6.5 (CI and summary are still useful), but Phase 8 must downgrade merge readiness.

### Message-based re-review (codex / external / human)

Post a re-review request comment via `{GH}:add_issue_comment`.

**For codex:**

```markdown
@codex review

The previously reported review threads have been addressed and resolved.
Please re-review the latest commit, focusing on:
- [summary of accepted fixes]
```

**For external / human (`<reviewer>` = detected reviewer login from Phase U1):**

```markdown
@<reviewer> レビュー指摘への対応が完了しました。

再レビューでは以下を中心に確認してください。
- [accepted fix summary]
```

Stop with `termination_status = WAITING_FOR_REVIEW(provider=<provider>)`. Do NOT loop back automatically.

When the user signals that a new review has been posted, increment `cycles_done` and re-enter at **Phase U1**.

---

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
- Acquisition provider: copilot-review | codex | external | existing | auto
- Unified thread handling used: yes
- Completion wait: native subscription | sdk-wrapper subscription | fallback polling | user-signaled | N/A
- Watch resource: <resource_uri or N/A>
- Watch ID: <watch_id or N/A>
- Notification received: yes | no | N/A
- Unsubscribed: yes | no | N/A
- Reviewer accounts: <login(s) and thread counts>

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
  - one of: `READY_TO_MERGE` | `ESCALATE — Clean` | `ESCALATE — Unverified Fix` | `WAITING_FOR_REVIEW(provider=...)`
  - On `ESCALATE — Unverified Fix`: include reason, the unverified commit SHA(s),
    and an explicit "Recommendation: human review of the last commit before merge".
- Re-review mode: structured | message-based | none
- Re-review status: completed | WAITING_FOR_REVIEW(provider=...) | not requested
- Final cycle fix types: blocking × N, non-blocking × N, suggestion × N, trivial × N
- Cycles done: N
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
- Re-review mode: structured
- Re-review status: completed
- Cycles done: 3
```

### Deferred / Scope-out Items rules

This section MUST list every reject whose reason was `out-of-scope`, `deferred`, or `follow-up` from this cycle:

```markdown
### Deferred / Scope-out Items
- #238 — Add tests for file distribution Supabase operations and W6 dialog
- #239 — Improve accessibility for file distribution status and download buttons
```

`- None` is only allowed when no reject used reason `out-of-scope` / `deferred` / `follow-up` AND no thread was left unresolved due to Phase U5 step 4.

If any item was left untracked:

```markdown
### Deferred / Scope-out Items
- Thread <id> — untracked — needs follow-up issue (Phase U5 step 4)
```

`Won't fix` rejects do NOT go in this section.

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
3. If the user still requests a merge, confirm explicitly that they have manually reviewed the unverified blocking fix before proceeding.

If `termination_status` is `WAITING_FOR_REVIEW(provider=...)`:

1. Do **not** report the PR as ready to merge.
2. Report: "Re-review requested from `<provider>`. Waiting for review before merge."

If any other condition is missing, report it instead of merging.

## Reporting Requirements

In the final response, include:

- PR URL
- **acquisition provider**: `copilot-review` | `codex` | `external` | `existing` | `auto`
- **unified thread handling**: always `yes`
- which completion wait route was used: native subscription, sdk-wrapper subscription, fallback polling, user-signaled, or N/A
- `resource_uri` and `watch_id` when available (copilot-review only)
- reviewer account login(s) and thread counts
- commits pushed
- CI status
- unresolved thread count (after paginated collection)
- for copilot-review — subscription evidence:
  - whether `{RSRC}:resources/subscribe` was actually used
  - whether `notifications/resources/updated` was received
  - whether `{RSRC}:resources/read` after notification reached a terminal watch state
  - whether `{RSRC}:resources/unsubscribe` completed
- for all providers — resolution evidence:
  - number of threads replied via `{GH}:add_reply_to_pull_request_comment`
  - number of threads resolved via `gh api graphql resolveReviewThread`
  - any threads left unresolved (with reason)
- merge readiness
- `termination_status` (`READY_TO_MERGE` / `ESCALATE — Clean` / `ESCALATE — Unverified Fix` / `WAITING_FOR_REVIEW(provider=...)`)
- `re-review mode`: structured | message-based | none
- `cycles_done`
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
