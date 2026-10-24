# FIX_REPORT.md — AgentScope Suite · JARVIS v2.1

**Repair branch:** `arena/80022a73-jarvish` (branched from `6ae10a1b1b42d74cc5d756217c8cb2d31724c7f0`)
**Date:** 2026-10-24
**Principle applied:** inspect → reproduce → fix the **root cause** → add a regression test that
fails on the old code → re-run the whole gate (type-check, lint, unit/integration tests,
production build). No feature was removed, no assertion was weakened, no test was skipped, and no
mock was used to prove an external service works.

Everything below is a real change in this branch. Each entry gives the file, what changed, *why*,
and the evidence that it works (the full log is in `TEST_RESULTS.md`).

---

## 1. Production build (Critical)

| File | Change |
|------|--------|
| `studio/src/lib/agentic/custom-tools.ts` | `runToolCode()` now assembles the runner argv with `push()` instead of a literal array at the `spawn()` call site, with a comment explaining why. |

*Why:* `npm run build` failed with
`Module not found: Can't resolve ('--experimental-permission' | <dynamic>)`.
Turbopack constant-folds the array literal in `spawn(exe, [...])` and treats its elements as module
specifiers. No behaviour change: the child process gets the same `--experimental-permission`,
`--allow-fs-read`, heap caps and runner path; the Node permission model and the 30 s cap are
untouched.

*Evidence:* `npm run build` → `✓ Compiled successfully`, standalone copy complete, exit `0`
(before: exit `1`). The sandbox isolation tests (`bug-hunt.test.ts` H8/H9/H14,
`repair-regressions.test.ts` custom-tool cases) still pass.

---

## 2. Repository / packaging integrity (Critical)

| File | Change |
|------|--------|
| `studio/.gitignore` | `test` → `/test`, `prompt` → `/prompt` (anchored to the project root) + explanatory comment; added `!.env.example`. |

*Why:* a bare `test` pattern matches a file or directory named `test` **anywhere**, so
`src/app/api/providers/[id]/test/route.ts` (fix 3) was invisible to `git status`, would never be
committed, and would be missing from every archive — while the UI calling it shipped. `prompt`
had the same latent hazard.

*Evidence:* `git status --porcelain` now lists the new route; the archive is generated from
`git ls-files` and `release/SHA256SUMS.txt` contains the route path.

---

## 3. Provider "Test connection" endpoint (High)

| File | Change |
|------|--------|
| `studio/src/app/api/providers/[id]/test/route.ts` | **NEW** — `POST` handler. |

*Why:* the route was missing (404). `src/app/api/route.ts` advertises it and
`src/lib/agentic/provider-connection.ts` claims to power it; `providers-panel.tsx` calls it, so
the **Test** button always failed.

*Behaviour:* `rejectIfUnauthorized()` guard (audited when refused) → unknown provider = 404 with
`errorCategory: 'config'` → `{ apiKey?, baseUrl?, model? }` from the body override the stored
credential (so unsaved settings can be tested) → `testProviderConnection()` → audit
`provider.test` with provider/model/`usedStoredKey` → the exact JSON the panel reads
(`{ ok, message, error, model, errorCategory }`). Invalid JSON = 400; an unexpected throw = 500
with the message and an audit row.

*Evidence:* `A1` (4 tests) + live `curl` returning a real connection result instead of 404.

---

## 4. SSE parsing — the last frame is no longer lost (High)

| File | Change |
|------|--------|
| `studio/src/lib/llm-core.ts` | Three copy-pasted parsers replaced by one `sseTextStream(response, extract, release)`; on EOF the remaining buffer is **flushed** through the same line handler. |

*Why:* an unterminated final `data:` frame was silently discarded, truncating the end of a reply
(no error, no warning). Also normalises `\r\n` handling and keeps `[DONE]`/keep-alive tolerance.

*Compatibility:* `sseChunksFromOpenAI/Anthropic/Gemini` keep their names and signatures; the
`release` callback (upstream socket drop on cancel) is still invoked from `cancel()`.

*Evidence:* `A2` (4 tests) — 3 fail on the old code, all pass now; the chunk-splitting case
(already correct) still passes.

---

## 5. OpenCode child environment (High, security)

| File | Change |
|------|--------|
| `studio/src/lib/agentic/opencode.ts` | New `openCodeEnv(config)` allow-list used by `executeOpenCodeTask()` **and** the `--version` probe; `{ ...process.env }` removed. |

*Why:* the CLI is an LLM-driven coding agent. Inheriting the Studio environment exposed
`AGENTSCOPE_SECRET_KEY` (AES key for all stored provider keys), `AGENTSCOPE_API_TOKEN` and
`DATABASE_URL` to model-authored commands. Every other spawner in the codebase already sanitises.

*Kept:* PATH, HOME/USER, locale, temp, XDG/APPDATA/USERPROFILE, Windows essentials, proxy
variables — plus only the per-run `config.apiKey` (as `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/
`OPENROUTER_API_KEY`) and `config.baseUrl`.

*Evidence:* `A4` — a fake `opencode` binary dumps its environment; the test asserts the three
secrets are absent and the per-run key is present. Fails before, passes after.

---

## 6. Chat error reporting (Medium)

| File | Change |
|------|--------|
| `studio/src/app/api/chat/route.ts` | The generic `502 "Unable to reach the model provider"` branch now maps the parsed provider status (401/403 → auth, 404 → unknown model, 400/422 → rejected request, ≥500 → provider failure, else network) and returns `{ error, errorCategory, provider, model }`; the provider's own message is masked through `protect()` before it leaves the server. |
| `studio/src/app/api/chat/route.ts` | Added `import { protect } from '@/lib/agentic/secrets'`. |

*Why:* a wrong API key, a retired model and a provider outage were all reported as a network
failure with status 502, so the user was told the wrong thing and never saw the remedy; the
provider/model that was actually used was not reported either.

*Evidence:* `A8` (3 tests) — all fail on the old code; a provider body that echoes `sk-wrong`
does **not** reach the browser (masked).

---

## 7. Task event stream flushes immediately (Medium)

| File | Change |
|------|--------|
| `studio/src/app/api/agentic/tasks/[id]/stream/route.ts` | Sends `: connected\n\n` before the poll loop and `: ping\n\n` after 15 quiet polls. |

*Why:* with no pending events the handler enqueued nothing, so the HTTP response was never
flushed: `fetch()`/`EventSource` stayed unresolved, the JARVIS dashboard showed "connecting" for
the entire quiet period, and proxies saw an idle request with no bytes.

*Evidence:* `A3` — the first chunk of a quiet, non-terminal task must start with `:` and contain
`connected` (old code: no chunk at all, test timed out at 15 s; new: ~10 ms).

---

## 8. Memory deletion must name a target (Medium, data loss)

| File | Change |
|------|--------|
| `studio/src/lib/agentic/memory.ts` | `deleteMemory()` throws `MemoryValidationError('scope', …)` when neither `id` nor a valid `scope` is supplied. |

*Why:* `DELETE /api/memory` with no query string fell through to `deleteMany({})`, removing user
preferences **and** every task's private notes in one request.

*Wiring:* the route already maps `MemoryValidationError` → HTTP 400 + `field`, so no route change
was needed; the UI always sends `id` or `scope`, so nothing in the UI changed.

*Evidence:* `A5` (3 tests) — the two delete tests fail on the old code.

---

## 9. ESLint configuration (Medium, tooling)

| File | Change |
|------|--------|
| `studio/eslint.config.mjs` | Rewritten as per-plugin-family blocks with explicit `files` scopes (react/next, TypeScript, core, CommonJS); ignores list extended (`.agentic-workspace/**`). |

*Why:* `npx eslint .` aborted with *"could not find plugin react-hooks"* because `react-hooks/*`
rules were applied to `scripts/custom-tool-runner.cjs`, for which `eslint-config-next` does not
register that plugin. Exit code 2, zero files linted — the project had no lint gate.

*Evidence:* `A6` (2 tests) using ESLint's own API; `npx eslint .` → **exit 0, 0 errors, 42
warnings** (all `react-hooks/set-state-in-effect` hints, kept visible on purpose).

---

## 10. Test-integrity repair (Low)

| File | Change |
|------|--------|
| `studio/tests/bug-hunt.test.ts` | The H7 test creates its own uniquely named workspace and removes it in `finally`; the payload is now a **real** newline (`['echo hi','rm -rf ./build'].join('\n')`). |

*Why:* the test passed only when a leftover `.agentic-workspace/task-h7` from an earlier run
existed (it failed on a clean checkout with `forbidden` instead of `destructive`), and the old
payload contained a literal backslash-n rather than the newline the fixed bug was about.

*Evidence:* the full suite is green on a fresh `.agentic-workspace`; the file alone reports
`3 pass / 0 fail`.

---

## 11. Retention for audit / agent records (Phase 4 gap → implemented)

| File | Change |
|------|--------|
| `studio/src/lib/agentic/retention.ts` | **NEW** — `retentionPolicyFromEnv()`, `retentionStatus()`, `pruneOldRecords()`. |
| `studio/src/lib/agentic/background.ts` | Daily `sweepRetention()` timer (started/stopped with the runtime); the sweep audit-logs its own result. |
| `studio/src/app/api/system/status/route.ts` | Reports the active policy under `retention`. |

*Why:* `AuditLog`, `AgentMessage` and `AgentEvent` grew without bound; only read notifications were
pruned.

*Safety:* disabled unless `AGENTSCOPE_RETENTION_DAYS ≥ 1`; security-category audit rows and any
row carrying an approval decision are **never** deleted; rows belonging to a task that is not
`done`/`failed`/`cancelled` are **never** deleted.

*Evidence:* live `GET /api/system/status` → `retention: { enabled:false, days:0, … }`; see
`FEATURE_STATUS.md` for the honest note that this path has no automated destructive test.

---

## 12. Documentation & configuration (deliverables)

| File | Change |
|------|--------|
| `studio/.env.example` | **NEW** — sanitized, documented example covering every variable the code reads (74 keys), with the required ones called out and no real credentials. |
| `studio/.gitignore` | allows `.env.example` while keeping `.env*` ignored. |
| `README.md` | setup / verification section: build, lint, tests, retention, the new route (see §13). |

---

## 13. Files changed — complete list

```
studio/.gitignore                                          (2)
studio/eslint.config.mjs                                   (9)
studio/src/lib/llm-core.ts                                 (4)
studio/src/lib/agentic/custom-tools.ts                     (1)
studio/src/lib/agentic/opencode.ts                         (5)
studio/src/lib/agentic/memory.ts                           (8)
studio/src/lib/agentic/retention.ts                        (11, NEW)
studio/src/lib/agentic/background.ts                       (11)
studio/src/app/api/providers/[id]/test/route.ts            (3, NEW)
studio/src/app/api/agentic/tasks/[id]/stream/route.ts      (7)
studio/src/app/api/chat/route.ts                           (6)
studio/src/app/api/system/status/route.ts                  (11)
studio/tests/bug-hunt.test.ts                              (10)
studio/tests/audit-2026-10-regressions.test.ts             (NEW — 19 tests)
studio/.env.example                                        (NEW)
README.md                                                  (12)
BUG_AUDIT_REPORT.md / FIX_REPORT.md / TEST_RESULTS.md /
SECURITY_REPORT.md / FEATURE_STATUS.md                     (NEW — this report set)
```

No file was deleted. `agentscope/` (the Python framework), the Python bridges, the Windows
PowerShell scripts, the existing test suite and every existing route were left in place.

---

## 14. Gate results after the changes

| Gate | Command | Result |
|------|---------|--------|
| Types | `npx tsc --noEmit` | **0 errors** (exit 0) |
| Lint | `npx eslint .` | **0 errors**, 42 warnings (exit 0) — was exit 2 |
| Tests | `bun test` | **752 pass / 0 fail**, 45 files — was 732/1 (and the 1 was B-10) |
| Build | `npm run build` | **success**, standalone tree written — was exit 1 |
| Runtime smoke | `curl` against ~45 endpoints + host/kill/task/memory/stream probes | all as documented in `TEST_RESULTS.md` |

Each fix was also checked the other way round: with the patch removed, the corresponding new test
fails (see the table in `TEST_RESULTS.md §4`). That is the evidence that the tests pin the bug
and not the patch.
