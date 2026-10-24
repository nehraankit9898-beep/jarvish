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
