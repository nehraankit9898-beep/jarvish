# AgentScope Studio — Test Results

> Every number below comes from a command that was actually executed in this
> environment (Windows 11, PowerShell 5.1).
>
> * Baseline — the state of the project **before** this work.
> * Final — the state **after** the completion work.
>
> The logs are kept in the repository: `typecheck-final.log`, `lint-final.log`,
> `test-final.log`, `build-final.log`.

---

## 0. Environment

| Tool | Version |
|---|---|
| OS | Windows 11 (win32) |
| Shell | Windows PowerShell 5.1 |
| bun | 1.4.2 |
| node | v22.23.3 |
| python | 3.14.8 (the `agentscope` package is **not** installed) |
| Next.js | 16.1.3 |
| Prisma | 6.11.1 (SQLite) |
| Date | 2026-10-21 |

---

## 1. Baseline vs. final

| Check | Command | Baseline | Final |
|---|---|---|---|
| Type check | `bun run typecheck` | **PASS** (0 errors) | **PASS** (0 errors) |
| Lint | `bun run lint` | **PASS** (0 problems) | **PASS** (0 problems) |
| Unit tests | `bun test` | **123 pass / 0 fail** (9 files) | **212 pass / 0 fail** (13 files) |
| Production build | `bun run build` | **PASS** (21 routes) | **PASS** (47 routes, 0 warnings) |
| Panel render | `bun run panels:render` | — (did not exist) | **7 / 7 panels render** |
| Health probe | `GET /api/health` | — (did not exist) | **200 `status: ok`** |
| Production start | `bun run start` | not exercised | **server boots, DB reachable** |

The project was already green before this task — the work was *additive
completion*, not a rescue. The count of tests grew by 89 and the route count
by 26.

---

## 2. Database migration

```
$ bunx prisma db push      # run twice — the second run reported "already in sync"
```

Resulting schema (16 tables, verified with a direct SQLite query):

| Table | Rows | Note |
|---|---|---|
| `Agent`, `Conversation`, `Message` | — | pre-existing |
| `AgenticTask` | **2** | **pre-existing rows preserved** |
| `AgenticStep`, `AgentEvent`, `AgentMessage` | — | pre-existing |
| `AuditLog` | 0 | new (cleared after the test runs) |
| `ProviderConfig` | 0 | new |
| `ModelPreference` | 0 | new |
| `StudioSetting` | 1 | new (`freeOnly=false`, the default) |
| `MemoryEntry` | 0 | new |
| `KnowledgeDoc`, `KnowledgeChunk` | 0 | new |
| `AutomationSchedule`, `AutomationRun` | 0 | new |

A backup of the pre-migration database is kept at
`db/custom.db.pre-completion.bak`.

---

## 3. The test suite

```
$ bun test
 212 pass
 0 fail
 642 expect() calls
Ran 212 tests across 13 files. [10.83s]
```

### 3.1 New files

| File | Tests | What it proves |
|---|---|---|
| `tests/subsystems.test.ts` | 32 | memory (scopes, credential refusal, isolation), knowledge (indexing, retrieval with sources, empty/binary refusal), automation (created disabled, arming, **duplicate-run prevention**, cancel), audit (write, read, redaction), env validation |
| `tests/provider-config.test.ts` | 26 | AES-256-GCM round trip, fresh IV per record, tamper detection, the key is never returned to the browser, cost-class inference, the routing policy, per-agent preferences, the studio settings |
| `tests/api-guards.test.ts` | 19 | every privileged route is guarded (401 without a token, 403 cross-origin), the **approval gate cannot be bypassed** |
| `tests/routing-policy.test.ts` | 12 | free-only never calls a paid/unknown provider, disabled providers are skipped, priority decides the order, the 8 agent roles exist and work |
| existing 9 files | 123 | the original engine — unchanged and still green |

### 3.2 The security regressions that are now covered

| Regression | Test |
|---|---|
| `POST /api/opencode/execute` without a token | `api-guards.test.ts` → "route guards (regression)" |
| `GET /api/opencode/detect` without a token | idem |
| `POST/GET /api/agent-registry/agents` without a token | idem |
| `PUT/PATCH/DELETE/GET /api/agent-registry/agents/[id]` without a token | idem |
| `POST /api/agent-registry/seed` without a token | idem |
| the new subsystem routes without a token | idem |
| approving a command the engine did **not** ask for | idem → "approval gate (regression)" |
| a secret in the audit details | `subsystems.test.ts` → "audit trail" |
| a credential in a memory entry | `subsystems.test.ts` → "memory" |
| a paid provider in free-only mode | `routing-policy.test.ts` → "free-only policy" |

---

## 4. Production build

```
$ bun run build
✓ Compiled successfully in 48s
✓ Generating static pages using 3 workers (30/30) in 953.3ms
...
ƒ Proxy (Middleware)          ← the Next 16 rename took effect, no deprecation warning
copied: .next\static  -> .next\standalone\.next\static
copied: public       -> .next\standalone\public
copied: prisma       -> .next\standalone\prisma
BUILD=0
```

47 routes are generated (21 before). The full list is in `build-final.log`.

---

## 5. Production smoke test

The standalone server was started with the documented script and queried over
HTTP.

### 5.1 Health probe (unauthenticated)

```json
{
  "status": "ok",
  "uptimeSeconds": 15,
  "timestamp": "2026-10-21T13:36:47.833Z",
  "checks": { "database": { "ok": true, "latencyMs": 25, "error": "" } }
}
```

### 5.2 Token enforcement (production, `AGENTSCOPE_API_TOKEN=test-token-123`)

| Request | Result |
|---|---|
| `GET /api/health` | **200** — the probe stays reachable |
| `GET /api/audit` (no token) | **401** |
| `GET /api/audit` (with the token) | **200** + the audit rows |
| `POST /api/memory` (no token) | **401** |
| `POST /api/memory` (with the token) | **201** — the entry was written |
| `GET /api/system/status` (no token, production) | **503** — fail-closed, exactly as designed |

The smoke-test memory row was deleted afterwards (the user scope is empty
again).

### 5.3 The Windows health-check script

```
$ powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1 -BaseUrl http://localhost:3111

  [OK]   health: ok (uptime 54s)
  [INFO] database latency: 1 ms
  [WARN] The status endpoint is fail-closed: NODE_ENV=production without AGENTSCOPE_API_TOKEN.
  [INFO] Set AGENTSCOPE_API_TOKEN in .env and restart …
EXIT=0
```

---

## 6. Development server smoke test

```
$ powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1 -Port 3120
▲ Next.js 16.1.3 (Turbopack)
○ Compiling proxy ...
[env] WARNING AGENTSCOPE_API_TOKEN: AGENTSCOPE_API_TOKEN is not set — the API is reachable from the same origin only. …
[env] configuration OK — 1 variable(s) configured (values are never logged).
✓ Ready in 24.5s
```

| Request | Result |
|---|---|
| `GET /` | **200**, 25 763 bytes |
| `GET /api/health` | **200** `status: ok` |
| `GET /api/system/status` | **200** `ok=true db=true providers=0 tools=10` |
| `GET /api/system/permissions` | **200** `policy=8 samples=6` |
| `GET /api/providers` | **200** `{providers:[], order:[…]}` |
| `GET /api/knowledge` | **200** |
| `GET /api/automation` | **200** |
| `GET /api/audit?limit=5` | **200** |
| `GET /api/memory?scope=user` | **200** |

The dev log shows `proxy.ts: <n>ms` next to every request — the rate limiter
(the renamed middleware) is active.

---

## 7. UI panels

The Studio shell is client-rendered, so the panels are verified by rendering
them on the server (the render function must not throw) and by the API
contract of every call they make.

```
$ bun run scripts/render-panels.tsx
  OK  ProvidersPanel: 13463 characters
  OK  MemoryPanel: 7666 characters
  OK  KnowledgePanel: 7420 characters
  OK  AutomationPanel: 6713 characters
  OK  AuditPanel: 5813 characters
  OK  SystemPanel: 4676 characters
  OK  DashboardPanel: 1971 characters

all panels render without an error
```

---

## 8. What is **NOT** verified here

| Item | Why | How to verify |
|---|---|---|
| The AgentScope **Python** bridge | the `agentscope` pip package is not installed in this environment | `pip install -e ..\agentscope`, then the header badge turns green and `POST /api/agentscope/run` works |
| A **real** LLM call (chat, plan, code, test) | no provider key is configured and no network egress is available | add a key in the Providers panel, then run an agentic task |
| The **OpenRouter / Groq / NVIDIA / Ollama** connection tests | they need a real key (Ollama needs a local server) | Providers panel → Test connection |
| The **Windows executable** packaging | out of scope — the deliverable is the source + the scripts | `bun run build` + `scripts\windows\start-prod.ps1` |
| **Browser** interaction (clicking through the panels) | no browser is available in this environment | open <http://localhost:3000> and click through the sidebar |
| A **multi-node** deployment of the rate limiter | the limiter is in-process by design | replace it with Redis (see the comment in `src/proxy.ts`) |

Nothing above is claimed as working. Everything else in this document was
executed.

---

## 9. How to reproduce

```powershell
cd path\to\agentscope-suite\studio

# 1. everything at once
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1

# 2. the checks
bun run typecheck
bun run lint
bun test
bun run build
bun run panels:render

# 3. run it
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1
```
