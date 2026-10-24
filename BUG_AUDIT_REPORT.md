# BUG_AUDIT_REPORT.md — AgentScope Suite · JARVIS v2.1

**Audit date:** 2026-10-24
**Revision audited:** `6ae10a1b1b42d74cc5d756217c8cb2d31724c7f0` (`main`) + branch `arena/80022a73-jarvish`
**Method:** read every runtime entry point, then *reproduce* each finding against the running code
(dev server on `127.0.0.1:3000`, direct unit probes through `bun`, and `curl` against the HTTP API)
before touching it. Nothing below is reported from a code smell alone: each item has a
reproduction and a measured "before / after".
**Environment limits** (details in `TEST_RESULTS.md`): Linux sandbox, no Chromium, no outbound
access to `binaries.prisma.sh`. None of the findings below depend on either — except where
explicitly marked *unverified here*.

Legend — **C** Critical · **H** High · **M** Medium · **L** Low
`CONFIRMED` = reproduced and fixed here · `OPEN` = reproduced, not fixed (with reason) ·
`SUSPECTED` = cannot be reproduced/has no reachable impact today.

---

## Summary

| ID | Severity | Area | State | One line |
|----|----------|------|-------|----------|
| B-01 | **C** | build / packaging | CONFIRMED → fixed | `npm run build` failed at HEAD: Turbopack mis-resolved the custom-tool `spawn` argv |
| B-02 | **C** | repository integrity | CONFIRMED → fixed | a bare `test` rule in `.gitignore` silently excluded a real API route from git and any export |
| B-03 | **H** | providers / API | CONFIRMED → fixed | `POST /api/providers/[id]/test` did not exist — the Providers panel "Test connection" button 404'd |
| B-04 | **H** | streaming / providers | CONFIRMED → fixed | all three SSE parsers discarded a final `data:` frame that had no trailing newline (truncated replies) |
| B-05 | **H** | security / process spawn | CONFIRMED → fixed | the OpenCode child process inherited the Studio's whole environment (AES key, API token, DATABASE_URL) |
| B-06 | **M** | chat / error handling | CONFIRMED → fixed | a wrong API key was reported as "Unable to reach the model provider" (502) |
| B-07 | **M** | realtime / dashboard | CONFIRMED → fixed | the task event stream sent no bytes until the first event, so the dashboard stayed on "connecting" |
| B-08 | **M** | memory / data loss | CONFIRMED → fixed | `DELETE /api/memory` with no query string wiped every memory scope |
| B-09 | **M** | tooling | CONFIRMED → fixed | `npm run lint` could not run at all (plugin scoping in the flat config) |
| B-10 | **L** | test integrity | CONFIRMED → fixed | the H7 regression test only passed when a leftover workspace directory existed, and it did not test a real newline |
| B-11 | **M** | persistence / Phase 4 | GAP → implemented | no retention for audit rows, agent messages or streamed events (unbounded growth) |
| S-01…S-06 | L / n-a | misc | OPEN / SUSPECTED | see the last section |

---

## B-01 — `npm run build` fails: the production bundle cannot be produced (Critical)

**File / function:** `studio/src/lib/agentic/custom-tools.ts` → `runToolCode()`

**Reproduction**

```bash
cd studio
npm run build
```

**Expected:** a production build (and the standalone tree the Windows scripts package).

**Actual (before)**

```
./src/lib/agentic/custom-tools.ts:487:17
Error: Module not found: Can't resolve ('--experimental-permission' | <dynamic>)
> Build error occurred
$ echo $?   # 1
```

The failure reproduces on a clean `.next` and is **not** caused by this repair pass: it was
verified with every change of this branch stashed (`git stash push` → `npm run build` → same error).

**Root cause.** The runner is started with

```ts
const child = spawn(nodeBinary, [
  '--experimental-permission',
  `--allow-fs-read=${runner}`,
  '--max-old-space-size=64',
  '--max-semi-space-size=4',
  runner,
], { … });
```

Turbopack constant-folds a *literal array* in a call whose first argument is non-static and then
treats the array elements as **module specifiers** — the build error literally names the first
element (`'--experimental-permission'`). Bisected: replacing the callee (`cp.spawn`,
`spawnChild(...)`) or the `stdio` option changes nothing; replacing the literal array with an
array built by `push()` makes the build succeed. The argv is identical at runtime.

**Fix.** Assemble the argv with `push()` and document why (same isolation, same flags). The
sandbox itself is unchanged — the existing custom-tool isolation tests (host-realm escape,
runaway async, deleted-tool) still pass.

**Regression test.** The production build *is* the test: `npm run build` (recorded in
`TEST_RESULTS.md`), plus the pre-existing sandbox tests in `tests/bug-hunt.test.ts`
(H8/H9/H14) and `tests/repair-regressions.test.ts`, which exercise the very argv that broke.
**Verified:** `npm run build` → `✓ Compiled successfully` + standalone copy, exit `0`.

---

## B-02 — `.gitignore` silently excluded a real API route (Critical, repository integrity)

**File:** `studio/.gitignore` (line `test`)

**Reproduction**

```bash
cd studio
mkdir -p 'src/app/api/providers/[id]/test'   # the "Test connection" route
git check-ignore -v 'src/app/api/providers/[id]/test/route.ts'
# studio/.gitignore:49:test   studio/src/app/api/providers/[id]/test/route.ts
```

**Expected:** the file is tracked / included in an export.

**Actual:** a bare `test` pattern (intended for a scratch file) matches **any** file or directory
named `test` at **any depth**. The route added by B-03 therefore never appeared in `git status`,
would not be committed, and would be missing from any archive built from the repository — while
the code that calls it (`providers-panel.tsx`) shipped. The same trap applies to any future
`…/test/…` route, fixture or directory.

**Root cause.** A bare path component without a leading `/` is a match-anywhere glob.

**Fix.** Anchor the scratch names to the project root (`/test`, `/prompt`) and explain the
pitfall in a comment; add `!.env.example` so the sanitized example (a deliverable) is not
swallowed by `.env*`.

**Regression test.** Verified by `git status` now listing
`studio/src/app/api/providers/[id]/test/`; the archive is built from `git ls-files` so the
checksum list in `release/SHA256SUMS.txt` contains the route.

---

## B-03 — The provider "Test connection" endpoint does not exist (High)

**File:** `studio/src/app/api/providers/[id]/test/route.ts` (**missing**)

**Reproduction**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:3000/api/providers/zai/test
# 404  (HTML error page)
```

**Expected:** the real connection test for the provider being edited, exactly like
`POST /api/test-connection` — the module comment in `provider-connection.ts` says
*"used by `/api/test-connection`, by `/api/providers/[id]/test`"*, and `GET /api` advertises
`/api/providers/{id}/test` in its `providers` group.

**Actual:** the route file did not exist, so the **Test** button in the Providers panel
(`src/components/studio/providers-panel.tsx:219`) always failed with a 404 and the panel showed
"Connection failed / Unknown error" — regardless of whether the key was valid. `data.ok` is read
from a JSON body, but the 404 body is HTML, so the failure surfaced as a JSON parse error.

**Root cause.** Route never implemented (the shared helper and the UI contract were).

**Fix.** New `POST /api/providers/[id]/test` route: same auth guard as every other provider
route, unknown provider → 404 with `errorCategory: 'config'`, body `{ apiKey?, baseUrl?, model? }`
wins over the stored credential (so *unsaved* settings can be tested), otherwise the stored key /
base URL is used; result is audited (`provider.test`) and returned in the shape the panel reads
(`{ ok, message, error, model, errorCategory }`).

**Regression test.** `tests/audit-2026-10-regressions.test.ts` → *A1* (4 tests): unknown provider
404, provider 401 → `errorCategory: 'auth'`, success → `ok` + the model actually used,
cross-origin POST refused before any outbound call.
**Verified:** live `curl` now returns a real result (`{"ok":false,"error":"fetch failed",
"errorCategory":"network","model":"gpt-4o-mini"}` in the network-less sandbox — an honest failure,
not a 404).

---

## B-04 — The last SSE frame is lost when it is not newline-terminated (High)

**File / function:** `studio/src/lib/llm-core.ts` → `sseChunksFromOpenAI`, `sseChunksFromAnthropic`,
`sseChunksFromGemini`

**Reproduction** (stubbed `fetch`, real parser — see `A2` tests)

```ts
// provider body ends WITHOUT a trailing "\n":
// data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n
// data: {"choices":[{"delta":{"content":" world"}}]}
const text = await completeText(messages, config, { getProvider });
// before: "Hello"      ← " world" silently dropped
// after : "Hello world"
```

**Expected:** every `data:` frame that was received is delivered.

**Actual:** each parser kept the tail of the buffer for the *next* chunk and threw it away on
`done` (`if (done) { controller.close(); return; }`). Any provider that closes the socket right
after its last event — common for OpenAI-compatible gateways and proxies, and for Gemini's
`alt=sse` — lost the final token(s) of the answer. There was no error, no warning: the reply was
just short.

**Root cause.** Line-oriented parsing without an EOF flush, copy-pasted three times.

**Fix.** One shared `sseTextStream()` reader: buffers partial lines, handles `\r\n`/`[DONE]`,
**flushes the remaining buffer through the same handler at EOF**, and keeps the existing
cancel/release semantics (a cancelled stream still drops the upstream socket). All three
provider kinds now delegate to it.

**Regression test.** *A2* (4 tests): unterminated last frame for openai-compatible, anthropic and
gemini; plus a frame split across transport chunks (which already worked and still does).
**Verified:** 3 of the 4 fail on the previous implementation, all pass now.

---

## B-05 — The OpenCode child process inherits the Studio's secrets (High, security)

**File / function:** `studio/src/lib/agentic/opencode.ts` → `executeOpenCodeTask()`

**Reproduction** (see test *A4*: a fake `opencode` binary dumps its own environment)

```
AGENTSCOPE_SECRET_KEY=super-secret-master-key   ← AES key for every stored provider key
AGENTSCOPE_API_TOKEN=super-secret-api-token     ← the Studio's own API auth token
DATABASE_URL=…                                  ← database location
```

**Expected:** an LLM-driven coding agent started by the Studio must not be able to read the
Studio's credentials — the same rule the rest of the codebase already follows.

**Actual:** `const env = { ...process.env }` handed **everything** to the CLI, which runs
model-authored commands inside the task workspace. "Print your environment" is a one-line prompt
away, and the values then travel to whatever model provider the CLI is configured with.

**Root cause.** The only process spawner in the codebase that did not use a sanitized environment
(`terminal.ts` → `sanitizedEnv()`, `host-control.ts` → `hostEnv()`, `desktop-bridge.ts` →
`bridgeEnv()`, `custom-tools.ts` → explicit allow-list already did).

**Fix.** `openCodeEnv(config)`: an explicit allow-list (PATH, HOME, locale, temp, XDG/APPDATA,
proxy variables, Windows essentials) plus **only** the provider key the caller passed for this
run (`config.apiKey`) and the optional base URL. Used for the `--version` probe as well.

**Regression test.** *A4* — the child's environment is captured and asserted free of
`AGENTSCOPE_SECRET_KEY`, `AGENTSCOPE_API_TOKEN` and `DATABASE_URL`, while the per-run key is
present. **Verified:** fails before, passes after.

---

## B-06 — Every provider failure is reported as "network unreachable" (Medium)

**File / function:** `studio/src/app/api/chat/route.ts` → `POST()`

**Reproduction** (stub the provider with a 401; see test *A8*)

```
before: HTTP 502 {"error":"Unable to reach the model provider."}
after : HTTP 401 {"error":"The provider rejected the API key (401). Check the key for
                  \"openai\" in Settings → API.","errorCategory":"auth",
                  "provider":"openai","model":"gpt-4o-mini"}
```

**Expected:** the response names the actual cause (bad key / wrong model / provider outage) and
carries the provider's own status; `provider` and `model` are reported (the task's requirement:
*"Report which provider/model was actually used"*).

**Actual:** only `429` was mapped. A 401 (wrong key), 404 (retired model), 4xx and 5xx all became
`502 + "Unable to reach the model provider"`, so the UI blamed the network while the provider was
answering correctly, and never suggested the real remedy. The provider's message was also thrown
away, so an operator had to read the server log.

**Root cause.** `parseApiError()` (which already extracts the status and `Retry-After`) was used
for 429 only; the fall-through branch was generic.

**Fix.** Map the parsed status: 401/403 → auth message, 404 → "the provider does not offer
`<model>`", 400/422 → rejected request (provider text, masked), ≥500 → provider failure, else a
network message that includes the (masked) reason. The provider body passes through
`protect().masked` before it can reach the browser, so a provider that echoes a key back cannot
leak it.

**Regression test.** *A8* (3 tests). **Verified:** all three fail on the previous code.

---

## B-07 — The task event stream sends nothing until an event exists (Medium)

**File / function:** `studio/src/app/api/agentic/tasks/[id]/stream/route.ts` → `GET()`

**Reproduction**

```bash
# a task that is NOT terminal and has no new events after the cursor:
curl -sS -N -m 6 -D h.txt 'http://127.0.0.1:3000/api/agentic/tasks/<id>/stream?after=9999'
# before: curl: (28) timed out … 0 bytes received,  h.txt is EMPTY (no status line)
# after : HTTP/1.1 200 OK …  body: ": connected\n\n"
```

**Expected:** the response opens immediately (an SSE endpoint that will stream later still has to
send its headers), and a quiet stream is observably alive.

**Actual:** the `ReadableStream` enqueued nothing until the first stored event, so the HTTP
response was never flushed. `openEventStream()` (`src/lib/sse-client.ts`) resolves only when the
response arrives, so `onopen` never fired and the JARVIS dashboard's live-task panel displayed
**"connecting"** for the whole quiet period between two steps; any proxy in between saw a request
that produced no bytes. A paused/awaiting-approval task with no further events looked hung for the
entire client timeout.

**Root cause.** No initial flush and no keep-alive.

**Fix.** Send `: connected\n\n` before the poll loop (flushes headers, ignored by the SSE parser)
and a `: ping\n\n` comment after every 15 quiet polls (~15 s).

**Regression test.** *A3* — asserts the first chunk of a quiet, non-terminal task starts with `:`
and contains `connected`. **Verified:** the old handler produced no chunk at all (the test timed out
after 15 s), the new one answers in ~10 ms.

---

## B-08 — An unfiltered memory delete wipes every scope (Medium, data loss)

**File / function:** `studio/src/lib/agentic/memory.ts` → `deleteMemory()`;
route `src/app/api/memory/route.ts` → `DELETE()`

**Reproduction**

```bash
curl -X DELETE http://127.0.0.1:3000/api/memory      # no query string
# before: {"ok":true,"removed":<N>}  ← user preferences AND every task's private notes gone
# after : HTTP 400 {"error":"Refusing to delete every memory entry …","field":"scope"}
```

**Expected:** a delete needs a target. The module documents two isolated scopes and the route
documentation says *"Without an id the whole scope is cleared"* (a **scope**, i.e. an explicit
user choice).

**Actual:** `deleteMemory({id: undefined, scope: undefined})` built `where = {}` and called
`deleteMany({})`, deleting the user's long-term memory *and* the private notes of every task —
including notes the current task may never see. One forgotten query parameter in a future caller
(a tool, a script, a retry) silently destroys state that cannot be reconstructed.

**Root cause.** The absence of a filter was treated as "delete all" instead of "invalid call".

**Fix.** Reject a delete with neither `id` nor `scope` (`MemoryValidationError` → HTTP 400 via the
route's existing handler). `id`, `scope=user` and `scope=task&taskId=…` behave exactly as before.

**Regression test.** *A5* (3 tests): `deleteMemory({})` rejects and both records survive;
`DELETE /api/memory` → 400 with `field: 'scope'`; `DELETE ?id=…` → 200 and removes exactly one;
`POST` still stores.
**Verified:** the two delete tests fail on the previous code.

---

## B-09 — `npm run lint` could not run at all (Medium, tooling)

**File:** `studio/eslint.config.mjs`

**Reproduction**

```bash
cd studio && npx eslint .
# before: Oops! Something went wrong!  ESLint: 9.39.5
#         A configuration object specifies rule "react-hooks/set-state-in-effect",
#         but could not find plugin "react-hooks".      (exit 2, zero files linted)
```

**Expected:** lint reports style/type findings.

**Actual:** the config appended **one** override block that referenced `@typescript-eslint/*`,
`react-hooks/*`, `react/*` and `@next/next/*` rules with no `files` scope. `eslint-config-next`
registers `react-hooks` only for `**/*.{js,jsx,mjs,ts,tsx,mts,cts}` and `@typescript-eslint` only
for `**/*.{ts,tsx}`; ESLint's default flat-config file set *also* includes
`scripts/custom-tool-runner.cjs`, so the plugin resolved to `undefined` there and ESLint aborted
before reporting a single finding. The whole project effectively had no lint gate.

**Root cause.** Rules pointing at plugins that are not registered for the file being linted.

**Fix.** Split the overrides per plugin family: react/next rules scoped to the set where those
plugins are registered, TypeScript rules to `**/*.{ts,tsx,mts,cts}`, plugin-free core rules to
everything (including `.cjs`), and a `.cjs` block that disables
`@typescript-eslint/no-require-imports` (the runner *is* CommonJS by design).

**Regression test.** *A6* (2 tests): ESLint's own API lints `scripts/custom-tool-runner.cjs`
without aborting and the resolved config for that file contains no `react-hooks/*` rule; plus a
structural assertion that the intended policy is still declared.
**Verified:** fails before (`exit 2`), passes after; `npx eslint .` → **0 errors, 42 warnings**.

---

## B-10 — The H7 regression test was state-dependent and did not test a newline (Low)

**File:** `studio/tests/bug-hunt.test.ts` → *H7 / executeCommand* test

**Reproduction**

```bash
cd studio && DATABASE_URL="file:../db/custom.db" bun test tests/bug-hunt.test.ts
# before, clean checkout: 1 fail
#   expected "destructive", received "forbidden"
# after: 3 pass
```

**Expected:** the test creates whatever state it needs.

**Actual:** it called `executeCommand('task-h7', …)` without creating `.agentic-workspace/task-h7`.
`assertWorkspaceCommand()` answers *"workspace is not ready"* with permission `forbidden`, so the
test only passed when a **previous full-suite run** had left that directory behind — a green suite
therefore depended on run order and on a dirty workspace. Separately, the payload was written as
`'echo hi\nrm …'` (a *literal* backslash-n, two characters), not the real newline that the fixed
bug (C1/H7) was about, so the multi-line property was never actually exercised.

**Root cause.** Shared filesystem state + an escaping mistake in the fixture.

**Fix.** The test now creates its own uniquely named workspace, removes it in `finally`, and builds
the payload with `['echo hi', 'rm -rf ./build'].join('\n')` — a real newline — asserting both that
the classifier escalates and that `executeCommand` refuses it.

**Verified:** fails on a clean checkout before, passes now (and the whole suite is green on a fresh
`.agentic-workspace`).

---

## B-11 — Unbounded growth: no retention for audit / agent messages (Medium, Phase 4 gap)

**Files:** `src/lib/agentic/retention.ts` (**new**), `src/lib/agentic/background.ts`,
`src/app/api/system/status/route.ts`

**Observation.** `AuditLog`, `AgentMessage` and `AgentEvent` are append-only. Only *read
notifications* older than 30 days were pruned; the audit trail, every agent hand-off (full text)
and every streamed event were kept forever. A Studio left running for months grows its SQLite file
without limit, and the 2 000-event cap applied per task only.

**Fix (implemented, opt-in and conservative).**

* `AGENTSCOPE_RETENTION_DAYS` (0/unset = **disabled**, the default) selects the cut-off;
* a daily sweep runs in the background runtime and **audits itself** when it removes anything;
* audit rows in the `security` category and **every** approval/denial decision are never removed;
* records of any task that is *not* in a terminal state (`done`/`failed`/`cancelled`) are never
  removed, whatever their age;
* the active policy is reported by `GET /api/system/status` → `retention`
  (`{ enabled, days, keepSecurityAudit, keepApprovalDecisions }`).

**Verification.** Live `GET /api/system/status` now returns
`"retention":{"enabled":false,"days":0,"keepSecurityAudit":true,"keepApprovalDecisions":true}`;
the module is pure SQL through Prisma (no cron edge cases) and is documented in `.env.example`.
**No unit test yet** — it is disabled by default and destructive-by-nature; the guard rules
(security rows, active tasks) are the reason it cannot be exercised safely against a shared test
database. This is stated plainly in `FEATURE_STATUS.md`.

---

## Suspected / open items (not fixed here, with the reason)

| ID | Where | Finding | Why it is not "fixed" |
|----|-------|---------|----------------------|
| S-01 | `orchestrator.ts` `finishTask()` | `JSON.parse(s.commands \|\| '[]')` on every step is unguarded; a malformed row would throw inside the report builder and could leave a task in `running`. | Only reachable if the column is corrupted by something else (no writer produces invalid JSON). Fixing it needs a way to inject a corrupt row into a *running* task to be honest about the test; reported instead of half-fixed. |
| S-02 | `audit.ts` `clearAudit()` / `DELETE /api/audit` | No `taskId` deletes the entire audit trail. | Documented behaviour of the route ("clear the audit trail", user action from the Audit panel). Flagged in `SECURITY_REPORT.md` because it also deletes security rows — an operator decision, not a bug to change silently. |
| S-03 | `audit.ts` `clientIp()` | Takes the first `x-forwarded-for` hop, which a client can spoof. | Pre-existing and harmless for a local-first single-user deployment; wrong behind an untrusted proxy. Documented, not changed (changing it would break setups that rely on it). |
| S-04 | `memory.ts` `listMemory()` | `search` filters *after* `take`, so a match beyond the 200-row window is not found. | Retrieval-quality issue, not incorrect data; the dedicated `findRelevantMemories()` path used by the agent scores before truncating. |
| S-05 | `host-control.ts` | In `ask` mode, `list`/`read` of any non-blocklisted path run without approval. | Deliberate, documented design (`README` mode table). Listed as an accepted risk in `SECURITY_REPORT.md`, with the blocklist extended to credential stores. |
| S-06 | Windows specifics (installer, PowerShell scripts, desktop bridge, tray) | Cannot be executed here (Linux sandbox). | Read and reviewed line by line; reproducible Windows instructions are in `TEST_RESULTS.md`. **Not claimed as verified.** |

---

## What was checked and found sound (no change)

* **Approval gate** — live probe: approving with a *different* action in the body executes the
  **stored** action verbatim; the approval is single-use (second approve → 404); approvals expire
  after 10 minutes; the agent has no tool that can approve. `resolveApprovedCommands()` cannot be
  widened by the caller.
* **Kill switch** — live probe: engages from the UI, persists to `.agentic-workspace/kill-flag.json`,
  refuses `exec`/write/delete while allowing `host.info`, and blocks `startPairing()`/`authenticate()`
  for the phone. Release only through an explicit op.
* **Path guards** — `.env`, `.ssh`, browser profiles, wallets and system directories are refused for
  read *and* write even with approval; symlinks are resolved (`realpathSync.native`) before the
  containment check.
* **Remote (phone) access** — 6-digit single-use code with TTL + 5-attempt destruction + per-client
  throttle, 256-bit constant-time token, 2 h idle expiry, 3-session cap, revoke-by-id, kill-switch
  awareness, in-memory only (no token survives a restart).
* **SSRF guard** — literal IPv4/IPv6 (including `::ffff:127.0.0.1`, `0:0:0:0:0:0:0:1`, 6to4) and
  DNS-resolved hosts are classified separately; private/link-local/metadata blocked; loopback only
  on explicit opt-in.
* **Custom-tool sandbox** — live probe: `process` access refused, code runs in a child process with
  the Node permission model, 30 s hard cap, and the registry only invokes **approved, active** tools.
* **Cron / DST** — `nextCronRun('30 2 * * *', …, 'America/New_York')` returns
  `2025-03-10T06:30Z` for the spring-forward gap in 9 ms (no infinite scan), `null` for Feb 30.
* **Task lifecycle** — live probe: `queued → planning → failed` on a planning error (never `done`);
  cancel → `cancelled`; second cancel is refused; a cancelled task cannot be resumed; a cancelled
  *running* batch is not marked passed (covered by the existing `task-lifecycle` tests).
* **Reviewer gate** — a PASS from the reviewer LLM is rejected unless real test commands executed
  and exited 0 (`evaluateTestGate`), so a task is never completed on prose alone.
