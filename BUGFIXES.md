# AgentScope Suite — Jarvis: Bug-Fix Report

**Scope:** `studio/src/lib/agentic/**` (13 files changed)
**Verification:** `npx tsc --noEmit` → 0 errors · `bun test` → **402 pass / 0 fail** · dedicated regression checks → 24/24 PASS

---

## 🔴 Critical

### C1 — Approval gate bypassed by multi-line commands (`terminal.ts`, `permissions.ts`, `host-control.ts`)
**Root cause:** `normalizeCommand()` / `classify()` collapsed `\n` into a space, and the shell-meta escalation regex `/[;|&$`()<>]/` did **not** include newlines. So `echo hi\nrm -rf …` classified by its first token as **safe** and auto-ran — while `bash -c` executes **both** lines (a newline is a command separator exactly like `;`).
**Fix:**
- `permissions.ts`: multi-line commands are now classified **line by line**; the strictest verdict wins. `echo hi\nrm -rf x` → `destructive`; benign `echo a\necho b` still auto-runs.
- `terminal.ts` + `host-control.ts` (exec): `\n`/`\r` added to the shell-metacharacter escalation set, consistent with `;`.

### C2 — Cron scheduler freezes the whole server on DST spring-forward (`cron.ts`)
**Root cause:** `nextCronRun('30 2 * * *', …, 'America/New_York')` jumps the scan to wall-time `02:30`, which **does not exist** on the spring-forward night (02:00→03:00). `toUtc()` mapped that phantom wall time back to a UTC instant whose wall clock is *earlier* — the cursor recomputed the same value forever → the 30 s background ticker wedged the process (every schedule/UI tick blocked).
**Fix:** monotonic-progress guard: every loop iteration must advance the cursor; a non-advancing candidate falls back to `prev + 1 min` and the scan walks past the gap (next valid firing: next day 02:30). Verified: returns in < 2 ms, picks `2025-03-10 06:30Z` (02:30 EDT), fall-back days and Feb-30 expressions still bounded.

### C3 — Cancelled command batch still marked passed (`orchestrator.ts`)
**Root cause:** `runCommandBatch()` returns `{ cancelled: true, fail: null, blocked: null }` when the task was cancelled mid-batch — but `executeStep()` **never checked the flag** and fell through to the success path: `stepSetStatus(passed)` + git snapshot of a half-executed batch.
**Fix:** `executeStep` now checks `batch.cancelled` first and returns `{ kind: 'cancelled' }` (the run loop already stops without touching the task's `cancelled` status).

### C4 — Payment guard bypassable via neutral selector (`browser/browser-service.ts`)
**Root cause:** the guard required **both** page-intel payment signals *and* the selector text to match `/pay|purchase|buy|…/`. Clicking `button[type=submit]` / `form button` / `input[type=submit]` on a checkout page sailed through.
**Fix:** when the page intel says the surface is a payment page (`paymentGuardDecision().requiresConfirmation`), **any submit-like selector** (`button`, `[type=submit]`, `[role=button]`, …) is treated as a payment commit and requires the user-only `confirmPayment` flag (the agent tool layer structurally cannot set it). Text/link clicks are unaffected.

## 🟠 High

### H1 — `find -delete` classed safe (`permissions.ts`)
**Fix:** `find|grep|rg` commands containing `-delete` escalate to **destructive** (approval required). Plain `find` stays safe.

### H2 — `mv a.txt /etc/passwd` not escalated (`permissions.ts`)
**Root cause:** `/^mv\s+\//` only caught a system path as the **first** argument; the destination was unchecked, so `mv` fell through to the review pattern and auto-ran.
**Fix:** new `classifyFileMoveTarget()` — for `mv`/`cp`, the **last argument (destination)** is classified: system locations (`/etc`, `/usr`, …, `~`, `$HOME`, drive roots) → **destructive** (approval). Relative workspace targets keep the old behavior.

### H3 — Goal engine stalls forever on dangling `dependsOn` (`goals.ts`)
**Root cause:** `parseGoalDecomposition()` numbered tasks **before** the validity filter; dropping one task left `dependsOn` entries pointing at an index that no longer exists → `nextRunnableSpec()` found no runnable spec forever and the goal silently stalled.
**Fix:**
- Parse now validates + dedupes first, **re-indexes sequentially**, remaps `dependsOn` (dropping self/out-of-range/dropped refs) and breaks any dependency **cycle** by falling back to sequential execution.
- `nextRunnableSpec()` defensively ignores deps that point at unknown spec indexes.
- Duplicate prompts are deduped (they used to bind two specs to one created task row, breaking goal→task matching).

### H4 — `invokeTool` forbids any tool payload > 500 chars (`tool-registry.ts`)
**Root cause:** `invokeTool` ran `${tool} ${JSON.stringify(parameters)}` through the **shell-command** classifier, whose length guard rejects > 500 chars as *forbidden*. Every realistic `file-write` (and any payload mentioning words like "shutdown") was rejected.
**Fix:** tool permission is enforced from the tool's **declared** `def.permission` only (forbidden tools still refused, destructive tools still need approval). The shell classifier remains exactly where it belongs — shell commands.

## 🟡 Medium

### M1 — Message-bus returns the oldest history window (`message-bus.ts`)
`persistedHistory()` used `orderBy seq asc + take` → the **oldest** N rows; long conversations never saw their recent messages again. Now fetches newest-first, applies the visibility filter, restores chronological order and keeps the tail (mirrors in-memory `historyFor`).

### M2 — `saveProvider` wipes `baseUrl` (`provider-store.ts`)
`baseUrl: (input.baseUrl ?? '').trim()` coerced a missing field to `''` and destroyed a custom endpoint on any unrelated save (enable/priority toggle). Now: absent field → stored value is kept; validation applies only to a provided URL. (`model`, `label`, `timeoutMs` already behaved this way.)

### M3 — Audit verdict mislabel (`custom-tools.ts`)
`decideCustomTool` audited a **rejected** tool with `approval: 'auto'` — the trail claimed no human decision was made. Now `approve → 'approved'`, `reject → 'denied'`, enable/disable → `'auto'`.

### M4 — Tool health-check always `ok` (`tool-registry.ts`)
`healthCheckTool` treated "did not throw" as healthy, but `invokeTool` **returns** `ok:false` results instead of throwing — every broken tool reported healthy. Now the result's own `ok` flag is the verdict and the error is surfaced.

### M5 — TOCTOU duplicate-run (`automation.ts`)
`startScheduleRun` checked `isScheduleBusy` (async DB read) and only then added the in-process claim — two overlapping ticks could both pass the check during the `await` and start two runs. The in-process claim is now taken **synchronously** (check + add, no await between), *then* the DB busy-check runs.

### M6 — Git exit codes ignored (`git-tools.ts`)
All git calls (`init`, `config`, `add`, `commit`, `diff`, `rev-parse`, `reset`, `clean`) ignored `exitCode`. A failed `git commit` still "succeeded" and `snapshot()` returned the **previous** HEAD hash as a fresh snapshot — rollback targets that were never saved. New `runGit()` helper throws on non-zero exit with the last stderr lines; all call sites use it.

## ⚪ Low (found during the audit)

| # | Where | Defect → Fix |
|---|-------|--------------|
| L1 | `tool-registry.ts` | Timeout `setTimeout` in `invokeTool` never cleared — one leaked armed timer per invocation → cleared in `finally`. |
| L2 | `browser-service.ts` | Agent sensitive-fill check tested the selector against the **joined list of all** sensitive fields → (a) every fill refused on any page containing a password field, (b) `autocomplete="cc-number"` slipped through. Now per-field token matching (selector ↔ intel field name/label/autocomplete) + keyword regex on the selector itself. |
| L3 | `goals.ts` | Duplicate prompts bound two specs to the same task row → deduped at parse time. |
| L4 | `goals.ts` | Dependency **cycles** in a decomposition stalled the goal → edges dropped (sequential fallback). |
| L5 | `host-control.ts` | Same newline meta gap as C1 in the `exec` classifier → `\n\r` added (multi-line `exec` now requires approval). |

---

## Files changed

```
studio/src/lib/agentic/automation.ts        (M5)
studio/src/lib/agentic/browser/browser-service.ts  (C4, L2)
studio/src/lib/agentic/cron.ts              (C2)
studio/src/lib/agentic/custom-tools.ts      (M3)
studio/src/lib/agentic/git-tools.ts         (M6)
studio/src/lib/agentic/goals.ts             (H3, L3, L4)
studio/src/lib/agentic/host-control.ts      (C1, L5)
studio/src/lib/agentic/message-bus.ts       (M1)
studio/src/lib/agentic/orchestrator.ts      (C3)
studio/src/lib/agentic/permissions.ts       (C1, H1, H2)
studio/src/lib/agentic/provider-store.ts    (M2)
studio/src/lib/agentic/terminal.ts          (C1)
studio/src/lib/agentic/tool-registry.ts     (H4, M4, L1)
```

## How to verify

```bash
cd studio
bun install
npx tsc --noEmit          # 0 errors
DATABASE_URL="file:../db/custom.db" npx prisma db push
DATABASE_URL="file:../db/custom.db" bun test   # 402 pass / 0 fail
```

The dedicated before/after regression checks (classifier escalation matrix, DST cron scans, goal-decomposition edge cases) are in `scripts/verify-fixes.ts` of the delivery bundle; the full unified diff is in `scripts/fixes.diff`.

---

# Round 2 — second audit pass (2026-10)

Same method, applied again over the whole `studio/src/lib/agentic/**` tree plus the
API routes: read the code, reproduce the failure, fix, add a regression test, then
re-verify with `tsc` + `bun test`. 30 fixes, one finding investigated and
confirmed NOT a bug (H27), and four audit notes; everything was reproduced
against the code before it was touched. Tags `H5 … H37` continue the numbering above and are
written into the source as `// H<n>:` comments.

## 🔴 Critical / high-impact

| # | Where | Bug |
|---|-------|-----|
| H8 | `custom-tools.ts` | The custom-tool "sandbox" was escapable: the scan only blocked `eval(` and `new Function`, so `Function("return process")()` and the `""["constructor"]["constructor"]` chain (built from string pieces — invisible to any source scan) walked straight out to the host realm, with `require`, `process.env` and raw `fetch` in reach. Tool bodies now run in a dedicated `vm` context (`codeGeneration` off, an explicit global whitelist, capped timers, hard 30 s timeout), the validator compiles the script exactly like the runner does, and `FORBIDDEN_CODE_PATTERNS` covers realm hops, prototype access, `Buffer`, `document`/`window` and raw `fetch`. |
| H11 | `tool-registry.ts`, `/api/tools/health` | A "health check" EXECUTED the tools: it git-`init`'d and committed in real task workspaces, ran `file-delete`/`git-rollback` because it passed `approvedCommands: [toolName]` (auto-approving every destructive tool from a GET endpoint), and reported every tool with a required parameter as BROKEN because its empty probe payload was rejected. Structural by default (registered + handler + definition satisfies the schema); `{ probe: true }` (`?probe=1`) is the explicit opt-in and only for `safe` tools that need no payload. |
| H13 | `outbound.ts` | The SSRF guard treated *any* IP literal as a loopback host (`net.isIP(host) !== 0`), which with `allowLoopback` also switched off the https requirement — `http://203.0.113.9` was accepted as a "loopback" endpoint. Meanwhile real loopback spellings it should have caught were missed: `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`, `::127.0.0.1`, 6to4-wrapped v4. IPv6 is now expanded to its 8 groups and the embedded-IPv4 forms go through the v4 rules. |
| H7 | `terminal.ts` | `executeCommand` classified the *whitespace-folded* command. `normalizeCommand` turns `\n` into a space, so `echo hi\nrm -rf ./build` read as one harmless `echo` to the classifier, the audit trail and the approval key — while `/bin/bash -c` ran both lines. Classification and the metacharacter check now see the raw payload; the folded form is only the approval-matching key. |
| H15 | `host-control.ts` | Same root cause in `classifyHostAction` for `exec`: the newline escalation from C1 was dead there, so under `AGENTSCOPE_HOST_MODE=trusted` a multi-line payload auto-ran. (Its `normalizeCommand` import is gone entirely.) |
| H5 | `scheduler.ts`, `orchestrator.ts` | A plan step whose `dependencies` referenced a step the final (truncated / re-planned) plan did not contain was **never ready and never failed** — the task just stopped. Added `planIndexes()` + `sanitizeStepDependencies()`, applied at every plan-creation site (`bounded`, `revisedBounded`, `planSteps`) and made `checkDependencies`/`readySteps` ignore edges to non-existent steps. |
| H35/H36 | `/api/tools/health`, `/api/system/status`, `/api/tools/invoke` | The registry is filled lazily per family, and the routes disagreed about it: `list` registered 9 families, `invoke` only 6 (`memory-*`, `conversation-recall`, `gmail-*`, `whatsapp-send` … returned "Unknown tool" although they were listed), and `health`/`status` registered none — an empty toolset, or a random subset depending on which request ran first. New `tool-catalog.ts` exports `ensureFullToolCatalog()` and every entry point calls it. |
| H24/H25 | `documents.ts` | Two ways to take the server down with one document: an xlsx cell ref (`r="AAAAAAAA1"`) padded the row with ~8 billion empty cells, and the PDF `TJ` array regex had two branches that both match a backslash — a stream of backslashes with no `]` was exponential. Column refs outside the real 16 384-column grid are dropped; the regex branches are now disjoint. |
| H17/H34 | `downloads.ts`, `*-bridge.ts` | Timeouts that stopped when the *headers* arrived: a server (or the local Python bridge) that trickles a body forever kept the request — and the agent task waiting on it — alive indefinitely, past any size cap. The timer is now re-armed per chunk (a real stall timeout) and cleared in a `finally`. |
| H31 | `orchestrator.ts` | `filesChanged` was persisted from the snapshot the step had when it was *loaded*, so every fix attempt overwrote the list and the files written by earlier attempts vanished from the step record, the diff view and the Coder→Tester hand-off. Now an accumulator, updated and persisted per attempt. |
| H21/H26 | `knowledge.ts`, `project-index.ts` | Deleting a document (or "Clear index", or re-indexing a file that became empty) removed the `KnowledgeDoc` row and left its `KnowledgeChunk` rows — the document's actual text — in SQLite forever, relying on an FK cascade that only fires when the connection has `PRAGMA foreign_keys = ON`. Chunks are now deleted explicitly. |
| H6 | `automation.ts` | M5's in-process claim was released in `finally` *unconditionally*, so a skipped duplicate run dropped the claim of the starter still in flight; the next tick saw an unclaimed schedule with no run row yet and started a second, concurrent run. Only the caller that took the claim releases it. |
| H10 | `tool-registry.ts` | `invokeTool` never validated against the declared schema: `file-read` reached `fs.readFile` with `path: 123` (ENOENT, "forbidden"-looking errors, no useful message) and missing required parameters were handled by whichever `params.x` line happened to crash. `validateToolParameters()` now checks required-ness and the declared types (with the parameter's own description in the message) and records its own audit entry. |
| H19 | `provider-connection.ts` | "Test connection"/"list models" allowed loopback for `ollama` **only**, while the code that actually calls models applies no outbound guard — so LM Studio / vLLM on `http://localhost:1234/v1` worked for chat but was reported broken with "resolves to a loopback address". Loopback is now allowed for any user-configured provider (private ranges, link-local and metadata still blocked) and can be closed with `AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK=0`. |
| H33 | `desktop-bridge.ts`, `voice-bridge.ts` | The bridge token was handed to the child via `--token <secret>`, and process argv is world-readable (`ps -ef`, `/proc/<pid>/cmdline`) — any local user could read the key to the mouse, keyboard and screen. It travels in `AGENTSCOPE_DESKTOP_TOKEN` only, which both bridge scripts already default `--token` from. |

## 🟡 Medium

| # | Where | Bug |
|---|-------|-----|
| H9 | `custom-tools.ts` | `deleteCustomTool` deleted the row but left the tool registered — a deleted tool stayed invocable until the next restart. Now `unregisterTool()` + the live custom-tool set. |
| H12 | `worker-lock.ts` | A lock file whose `heartbeatAt` failed to parse produced `NaN` comparisons — the dead worker looked permanently fresh, so the singleton runtime never took over. A non-finite heartbeat is stale. |
| H14 | `custom-tools.ts` | The scan rejected code it could not compile-check; validation now parses the script through the same `vm.Script` the runner uses, so "saved OK / failed at run time" is gone. |
| H16 | `browser/browser-service.ts` | Navigation applied the provider policy, including `requireHttps`, so the browser refused the plain-`http://` links it advertised as allowed. The address rules still apply (private/link-local/metadata blocked, loopback still opt-in). |
| H18 | `downloads.ts` | The watcher's startup pass, commented "seed the known-set without notifying", notified anyway: any file touched in the last 10 minutes produced a phantom "New file in Downloads" on *every* restart. The seed scan is silent now. |
| H20 | `audit.ts` | `details` were secret-masked, `artifact` was not — and the artifact is where callers dump what they touched (tool payloads, request bodies). Masked the same way. |
| H22/H23 | `documents.ts` | A zip whose local header lies about `nameLen`/`extraLen` sliced past EOF and `subarray` clamped silently → garbage treated as document text; and one `&#99999999;` aborted the whole extraction with a raw `RangeError` from `String.fromCodePoint`. Out-of-range/`surrogate` references are left literal. |
| H28 | `provider-store.ts` | M2 preserved `model`/`baseUrl` when a field was absent, but `costClass` was re-inferred on every partial save — so reordering priorities or renaming a provider silently discarded the user's explicit free/paid classification and quietly changed free-only routing. |
| H29 | `provider-store.ts` | `costClassOf` returned the provider-level class first, so an OpenRouter-style `…:free` model on a paid provider was "paid": free-only mode rejected exactly the free models it existed to use (`no_model_available`), and "prefer free" never moved them up. The per-model marker now wins. |
| H37 | `tool-registry.ts` | Even in opt-in probe mode, `workspace-create` and `browser-session` were executed — a status endpoint that creates directories and leaves an orphaned live Playwright session (plus DB row and audit entry) behind per call. They are structural-only. |
| H27 (not a bug) | `model-router.ts` | Fallback targets deliberately get `maxRetries ?? 0` while the role primary gets the default — asserted by `tests/model-router.test.ts` ("3 attempts on the primary + 1 on the fallback"). Left alone. |

## ⚪ Notes from the audit (no code change)

* `WorkspaceLock` hand-off (`scheduler.ts`) compares holder strings, so a stale
  release can drop a new writer's lock; orchestrator holders are unique per step
  (`step-<index>`), so it is not reachable today.
* A screen task records `history.push(describeAction(action))` after an approval
  without checking the executed action's result — the trail can claim an action
  that the bridge then failed. Cosmetic, but worth knowing.
* `recordAudit` takes the client IP from `x-forwarded-for`, which is spoofable;
  fine for a local-first app, wrong for a multi-tenant one.
* `neutralizeInjection`/`asUntrustedReference`, `allowed-roots` symlink descent
  (Dirents for symlinked dirs are not `isDirectory()`, so the tree walker never
  follows links), `permissions.ts`, `cron.ts`, `memory.ts`, `roles.ts`,
  `approvals.ts`, `secrets.ts`, `crypto.ts`, `remote-session.ts`, `git-tools.ts`,
  `audit.ts` redaction, `host-control` approval queue/kill-switch ordering and
  `message-bus` visibility rules were re-read and are sound.

## Files changed (round 2)

```
studio/src/lib/agentic/scheduler.ts          (H5)
studio/src/lib/agentic/orchestrator.ts       (H5, H31)
studio/src/lib/agentic/automation.ts         (H6)
studio/src/lib/agentic/terminal.ts           (H7)
studio/src/lib/agentic/host-control.ts       (H15)
studio/src/lib/agentic/custom-tools.ts       (H8, H9, H14)
studio/src/lib/agentic/tool-registry.ts      (H10, H11, H37)
studio/src/lib/agentic/outbound.ts           (H13)
studio/src/lib/agentic/worker-lock.ts        (H12)
studio/src/lib/agentic/downloads.ts          (H17, H18)
studio/src/lib/agentic/documents.ts          (H22, H23, H24, H25)
studio/src/lib/agentic/knowledge.ts          (H21)
studio/src/lib/agentic/project-index.ts      (H26)
studio/src/lib/agentic/provider-store.ts     (H28, H29)
studio/src/lib/agentic/provider-connection.ts(H19)
studio/src/lib/agentic/audit.ts              (H20)
studio/src/lib/agentic/desktop-bridge.ts     (H33, H34)
studio/src/lib/agentic/voice-bridge.ts       (H33, H34)
studio/src/lib/agentic/browser/browser-service.ts (H16)
studio/src/lib/agentic/tool-catalog.ts       (NEW — H35/H36)
studio/src/app/api/tools/route.ts            (H35)
studio/src/app/api/tools/health/route.ts     (H11, H35)
studio/src/app/api/tools/invoke/route.ts     (H36)
studio/src/app/api/system/status/route.ts    (H11, H35)
studio/src/app/api/laptop/route.ts           (H35)
studio/tests/bug-hunt.test.ts               (NEW — 22 regression tests)
studio/tests/bug-hunt-2.test.ts             (NEW — 19 regression tests)
```

## How to verify (round 2)

```bash
cd studio
bun install
npx tsc --noEmit      # 0 errors
bun test              # 703 pass / 0 fail (40 files)
bun test tests/bug-hunt.test.ts tests/bug-hunt-2.test.ts   # the 41 new checks
```

Every new test was also run against the *unpatched* code where the failure was
mechanical (H5, H6, H8, H10, H11, H13, H21/H26, H22–H25, H37 reproduce the old
behaviour and fail; the fix makes them pass), so they pin the bug, not the patch.

Known flake, pre-existing and unrelated to these changes:
`new-features.test.ts > notifications > … prune` occasionally fails on a
same-millisecond `createdAt` tie when the whole suite shares one in-memory `db`
across files. It passes when the file runs alone and in repeated full runs.
