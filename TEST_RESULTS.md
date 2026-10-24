# TEST_RESULTS.md — AgentScope Suite · JARVIS v2.1

Every command below was actually executed in this workspace on 2026-10-24. Nothing in this file
is simulated or copied from an earlier report. Where a check could **not** be run (no browser, no
Windows host, no outbound provider access) it says so explicitly instead of inventing a result.

---

## 0. Environment used

| Item | Value |
|------|-------|
| OS / kernel | Linux 6.1.158 (x86-64 sandbox) |
| Node.js | v22.22.3 |
| npm / bun | npm 10.9.8 · bun 1.4.4 |
| Python | 3.11.2 (the Python bridges start; local TTS/wake models are not installed) |
| Working tree | `/home/user/jarvish` @ `arena/80022a73-jarvish` (from `6ae10a1b`) |
| Node modules | `npm install` (866 packages) then `bun` for the runner |
| Database | SQLite `studio/db/custom.db`, schema pushed with `prisma db push` |

### Two sandbox limitations and how they were handled

1. **Prisma's native query engine could not be downloaded** (`binaries.prisma.sh` is not reachable
   from this sandbox, `npm` cannot build `better-sqlite3` because `node-gyp` needs nodejs.org).
   `prisma generate` was run against the WASM query engine that ships inside the installed
   `prisma` package, and the **real SQLite file is used through the libSQL driver adapter**
   (`@prisma/adapter-libsql`, installed for the sandbox only). This is a *sandbox harness*
   detail: no project source was changed for it, no data was mocked, and the same queries run
   against the same file. Consequence to be aware of:
   **the dev server and the test suite must not hold the same SQLite file at the same time** in
   this harness — the WASM adapter reports `SocketTimeout` under two writers. An early run was
   done with the dev server up and produced 73 spurious failures; the results below are from runs
   with the server stopped. On a normal machine (native engine, WAL mode) this does not apply.
2. **No browser.** `npx playwright install chromium` fails (the CDN is unreachable) and no system
   Chromium exists. Therefore **no browser-automation test was run**: UI behaviour was verified by
   (a) reading the component ↔ route contract, (b) `curl` against the live dev server, and
   (c) SSR of `/` returning 200 with the JARVIS shell. No claim of "UI verified in a browser" is
   made anywhere in this report.

---

## 1. The gate, after the repair

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `npx tsc --noEmit` | **0** | no type errors |
| 2 | `npx eslint .` | **0** | 0 errors, **42 warnings** (all `react-hooks/set-state-in-effect`, intentionally kept as warnings) |
| 3 | `bun test` | **0** | **752 pass / 0 fail**, 2 273 assertions, 45 files, 13.2 s |
| 4 | `npm run build` | **0** | `✓ Compiled successfully`, route table printed, `copy-standalone` copied `.next/static`, `public`, `prisma`, `scripts/custom-tool-runner.cjs` |

Raw tails:

```
# 3
 752 pass
 0 fail
 2273 expect() calls
Ran 752 tests across 45 files. [13.22s]

# 4
✓ Compiled successfully in 11.5s
...
copied: scripts/custom-tool-runner.cjs -> .next/standalone/scripts/custom-tool-runner.cjs
build_exit=0
```

---

## 2. Baseline, *before* any change (so the delta is auditable)

| Command | Exit | Result |
|---------|------|--------|
| `npx tsc --noEmit` | 0 | clean |
| `npx eslint .` | **2** | `Oops! Something went wrong! … could not find plugin "react-hooks"` — **zero files linted** |
| `bun test` | 1 | **732 pass / 1 fail** (44 files). The failure: `H7 … executeCommand refuses the multi-line payload` → `expected "destructive", received "forbidden"` |
| `npm run build` | **1** | `Module not found: Can't resolve ('--experimental-permission' | <dynamic>)` at `custom-tools.ts:487` |
| `npm run build` with **this branch's changes stashed** | **1** | identical error — the build break is pre-existing, not introduced here |

---

## 3. Live runtime verification (dev server on `127.0.0.1:3000`)

Started with `node scripts/dev.mjs --port 3000 --host 0.0.0.0` (Next 16.4.3, Turbopack).
Boot log: `[env] configuration OK — 2 variable(s) configured`, `[background] runtime starting
(tick=30000ms)`, `[background] Downloads watcher started`.

### 3.1 Every GET endpoint answers (45 probed, all `200` unless noted)

```
/api  /api/health  /api/system/status  /api/system/permissions  /api/system/pc-health
/api/providers  /api/model-preferences  /api/persona  /api/memory  /api/settings
/api/audit  /api/tools  /api/tools/health  /api/tools/audit  /api/conversations
/api/agents  /api/agent-registry/agents  /api/agentic/tasks  /api/automation  /api/goals
/api/notifications  /api/suggestions  /api/world  /api/browser  /api/knowledge
/api/connectors  /api/recipes  /api/workflows  /api/prompt-versions  /api/recovery
/api/remote/status  /api/opencode/detect  /api/agentscope/status  /api/laptop  /api/host
/api/screen/watch  /api/voice/wake
```

Deliberate non-200s, all correct:
`GET /api/jarvis` → **405** (POST-only route) · `POST /api/voice/wake {"action":"start"}` →
**502** *unknown op* (the UI sends `op:`) · `GET /api/knowledge/project` → **400**
*A project root is required* · `POST /api/providers/zai/test` (before the fix) → **404 HTML**.

Honest degradations observed (no fabricated success):
`/api/agentscope/status` → `{"ok":false, "python":"Python 3.11.2", "agentscope":null}` ·
`/api/opencode/detect` → `{"installed":false, …}` · `POST /api/voice/speak` →
`503 {"error":"No module named 'edge_tts'","fallback":"browser"}` ·
`/api/laptop` → `voice.ready:true, ttsAvailable:false, wakeEngine:"none",
engine_detail:"No module named 'openwakeword'"`.

### 3.2 Security-critical flows (live HTTP probes)

| Flow | Probe | Result |
|------|-------|--------|
| Host approval executes the **stored** action | `op:request exec "echo hello-from-probe"` → `op:approve` with a *different* action (`rm -rf /tmp/…`) | ran `echo hello-from-probe`, exit 0; the swapped action was ignored |
| Approval is single-use | second `op:approve` with the same id | `404 {"ok":false,"error":"approval not found or expired"}` |
| Sensitive path refused without approval | `op:request read /home/user/jarvish/studio/.env` | `refused / forbidden — credential / key / browser-profile location` |
| Kill switch | `POST /api/laptop {"op":"kill"}` → host `exec` → `host.info` → `{"op":"resume"}` | exec `refused (KILL SWITCH engaged)`; `info` allowed; resume → `killed:false` |
| Task lifecycle | create task with no provider configured | `502 {"error":"Planning failed: Z.ai is not configured…","taskId":…}`, DB row `status=failed` (**never `done`**) |
| Cancel | `POST /cancelled/tasks/<id>/cancel` twice, then `/resume` | `{"ok":true,"status":"cancelled"}` → `{"error":"Task is already cancelled"}` → `{"error":"Task is cancelled and cannot be resumed"}` |
| Custom tool (sandbox) | create → invoke before approval → approve → invoke → try `process` escape | `pending_approval` → `404 Task not found` → `active` → `{"ok":true,"data":"2"}` → create rejected: *Unsafe tool code — process access is not available* |
| Provider test route (after fix) | `POST /api/providers/openai/test {"apiKey":"sk-invalid-test"}` | `200 {"ok":false,"error":"fetch failed","errorCategory":"network","model":"gpt-4o-mini"}` (real attempt; the sandbox has no outbound HTTPS to OpenAI) |
| Memory CRUD | POST/GET/DELETE `/api/memory` | create → list → delete by id = `{"ok":true,"removed":1}` |
| Knowledge | `POST /api/knowledge` + `GET /api/knowledge/search?q=ZZTOP` | doc indexed (`chunkCount:1`), search hit with snippet |
| Persona / settings | POST then GET | persisted (`personaId:"friday"`), `freeOnly:true` round-tripped |
| Conversations | create → get → delete | `201` → detail → `{"ok":true}` |
| SSE task stream (after fix) | `curl -N '…/stream?after=9999'` on a quiet task | `HTTP/1.1 200 OK` immediately, body `: connected` (before: no headers, 0 bytes) |
| SSE replay | `…/stream?after=0` on a finished task | frames `id: 1`,`id: 2`,… then `event: end` |

### 3.3 SSR page

```
GET / → HTTP 200, 16 251 bytes, contains "J.A.R.V.I.S" and the `jarvis-scope` shell
```

---

## 4. Regression tests added, and the proof they pin the bug

New file: `studio/tests/audit-2026-10-regressions.test.ts` (19 tests).
Anti-regression run: the same file executed **against the pre-fix code** (branch changes stashed,
the new route temporarily moved aside).

| Test group | What it asserts | Pre-fix code | Post-fix code |
|-----------|-----------------|--------------|---------------|
| **A1** provider test route (4 tests) | 404 for unknown provider; 401 → `auth`; success → `ok` + model; cross-origin refused | file missing → `Cannot find module …/test/route` (route absent, live 404 confirmed by curl) | 4 pass |
| **A2** SSE tail (4 tests) | last unterminated frame survives for openai/anthropic/gemini + split-chunk reassembly | **3 fail** (`"Hello"` instead of `"Hello world"`), split-chunk passes | 4 pass |
| **A3** stream preamble | quiet, non-terminal task yields `: connected` as the first chunk | **fail** (no chunk; 15 s timeout) | pass (~10 ms) |
| **A4** opencode env | child env free of `AGENTSCOPE_SECRET_KEY` / `AGENTSCOPE_API_TOKEN` / `DATABASE_URL`, per-run key present | **fail** (secret visible in the child) | pass |
| **A5** memory delete (3 tests) | `deleteMemory({})` refuses; `DELETE /api/memory` → 400 `field:"scope"`; `?id=` → 200; POST still works | **2 fail** (rows wiped / 200 instead of 400) | 3 pass |
| **A6** eslint (2 tests) | ESLint can lint `scripts/custom-tool-runner.cjs`; no `react-hooks/*` for `.cjs`; policy still declared | **2 fail** (`could not find plugin "react-hooks"`) | 2 pass |
| **A7** executeCommand | a real-newline payload is refused as `destructive` in a workspace that exists | passes (it guards the *test* fix, see B-10) | passes |
| **A8** chat error mapping (3 tests) | provider 401 → 401 `auth` + masked body; 404 → names the model; 5xx → provider failure | **3 fail** (`502 "Unable to reach the model provider"`) | 3 pass |

Pre-fix run summary: `7 pass / 9 fail`. Post-fix: `19 pass / 0 fail`.
`tests/bug-hunt.test.ts` H7: **1 fail → 3 pass** (B-10).

---

## 5. What was *not* verified here (and why)

| Item | Status | Reason | What to run on a real host |
|------|--------|--------|----------------------------|
| Real LLM round-trip (any provider) | **not verified** | no provider credentials and no outbound HTTPS in this sandbox; the adapter paths are covered by deterministic stubs (A1/A2/A8) | `npm run dev` → Settings → API → *Test connection* per provider |
| Gemini / Anthropic / DeepSeek live streaming | **not verified** | same | one chat per configured provider; check `Server-Timing` header and the reply tail |
| Windows installer / PowerShell scripts / desktop bridge / tray | **not verified** | Linux sandbox | `powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1` then `install-studio.ps1` (see `studio/docs/WINDOWS_SETUP.md` + `TEST_RESULTS` §7) |
| Microphone → recognition → TTS (browser voice) | **partially** | the Python bridge starts and answers (`ready:true`) but `edge_tts`/`openwakeword` are not installed; recognition is browser-side and needs a real browser + mic | `pip install -r python-bridge/requirements-voice.txt`, open the UI, press the mic |
| Phone remote page (real device) | **not verified** | needs a phone + the reachable PC; the server side is covered by `tests/remote.test.ts` (pairing/throttle/revoke/kill) and the live `/api/remote/status` probe | pair from the *Remote* panel |
| Browser automation (Playwright) against real pages | **not verified** | Chromium download blocked | `npx playwright install chromium` then `bun run scripts/browser-smoke.ts` |
| World monitor live data | **not verified** | GDELT/news need outbound access | open the *World* panel with network access |
| Visual/UX review of the JARVIS dashboard | **not verified** | no browser | open `http://localhost:3000` |

---

## 6. Flakes, noise and known non-determinism

* `new-features.test.ts > notifications > prune` has a pre-existing same-millisecond
  `createdAt` tie; it passed in every run of this session (documented, not "fixed" by weakening it).
* `project-index.test.ts` needs a per-test timeout > 5 s in this sandbox; the suite was run with
  `--timeout 30000` (the repo's own `bun test` uses Bun's default, which is enough on normal hardware).
* `bun test` must not run while the dev server holds the same SQLite file (see §1 limitation 2).
* The 42 lint warnings are real (`react-hooks/set-state-in-effect` in ~40 panels); they are
  performance hints about the existing "load in an effect" pattern, deliberately not silenced.

---

## 7. Reproducing all of this from a clean checkout

```bash
# 1. install + configure (generates .env and pushes the SQLite schema)
cd studio
npm install          # or: bun install
npm run setup

# 2. gates
npx tsc --noEmit     # expect: exit 0
npx eslint .         # expect: exit 0, 42 warnings
bun test             # expect: 752 pass / 0 fail
npm run build        # expect: exit 0, standalone output

# 3. run
npm run dev          # http://localhost:3000
```

On Windows, `.\scripts\windows\setup.ps1`, `…\start-dev.ps1`, `…\health-check.ps1`,
`…\install-worker.ps1` and `…\build.ps1` are the supported entry points; they were reviewed but
not executed here (`FEATURE_STATUS.md` marks every Windows-only capability as *unverified*).

---

## 8. Distributable archive

Built with `tools/build-release.sh` (in the repository, so it can be re-run):

```
release/agentscope-suite-jarvis-v2.1-repaired-20261024.tar.gz
size    2.0 MB
entries 1255
checksum recorded in release/SHA256SUMS.txt (the archive is rebuilt from this tree,
         so a hash written into this document would immediately be stale)
```

The archive is generated from `git ls-files` **plus** the deliverables that are new on this branch
(the five reports, `.env.example`, the provider test route, `retention.ts`, the new test file).

Integrity checks that ran as part of the build (the script aborts on a hit):

| Check | Result |
|-------|--------|
| no `node_modules/`, `.next/`, `out/`, `build/`, `dist/`, `coverage/` | pass |
| no `*.db` / `*.sqlite` (the tracked `prisma/db/custom.db` placeholder is skipped) | pass |
| no `.env` anywhere (`.env.example` is the only env file) | pass |
| no `.agentic-workspace/`, `dev.log`, `.secret-key`, `.desktop-token` | pass |
| no credential-shaped string outside `tests/` and `docs/` | pass |
| the live `AGENTSCOPE_SECRET_KEY` value from `studio/.env` appears **nowhere** in the tree | pass (direct grep) |
| the new route `studio/src/app/api/providers/[id]/test/route.ts` **is** in the archive | pass (extracted and listed) |

Verification of the archive contents (extracted to a temp dir):

```
studio/src/app/api/providers/[id]/test/route.ts     → present
studio/src/lib/agentic/retention.ts                 → present
studio/tests/audit-2026-10-regressions.test.ts      → present
studio/.env.example                                 → present
BUG_AUDIT_REPORT.md FIX_REPORT.md TEST_RESULTS.md SECURITY_REPORT.md FEATURE_STATUS.md → present
```

`SHA256SUMS.txt` (next to the archive) records the checksum of the `.tar.gz`;
`TREE-*.txt` records the exact file list.

**Not verified for the archive:** a from-scratch `npm install && npm run build` *inside the
extracted copy* — that needs the Prisma engine download that this sandbox cannot perform (see §0).
The archive was produced from the same tree that passed the gates in §1, and the extracted files
were listed/spot-checked, but the "clean-room install" step remains for a networked machine:

```bash
tar -xzf agentscope-suite-jarvis-v2.1-repaired-*.tar.gz
cd agentscope-suite-jarvis-v2.1-repaired-*/studio
npm install && npm run setup && npm run build
```
