# AgentScope Studio — Implementation Plan

> The plan that was executed for the completion work. Every item lists the
> files it touched and the command that proves it.
> The measured results are in `docs/TEST_RESULTS.md`, the before/after status
> of every feature is in `docs/COMPLETION_AUDIT.md`.

---

## 0. Ground rules

1. **No rewrite.** The project was already green (typecheck, lint, 123 tests,
   production build). Every change is additive or a targeted fix.
2. **No dead code.** A new module is only added when a route, a panel or a
   test consumes it. A new test always runs.
3. **No secrets in the browser.** Provider keys are encrypted on the server;
   only a 4-character hint is returned to the UI.
4. **Every rule is enforced on the server.** The UI never hides a control to
   enforce a policy — the policy is in the code that runs the action.
5. **Evidence, not claims.** Each phase ends with `bun run typecheck`,
   `bun run lint`, `bun test` and (at the end) `bun run build`.

---

## Phase 1 — Data model (the foundation for everything else)

**Goal:** the audit, provider, memory, knowledge, automation and settings
concepts need a home in the database.

| Step | Change | Files |
|---|---|---|
| 1.1 | 9 new Prisma models | `prisma/schema.prisma` |
| 1.2 | Backup the live SQLite file | `db/custom.db.pre-completion.bak` |
| 1.3 | Apply the schema without data loss | `bunx prisma db push` (×2) |
| 1.4 | Regenerate the client | `bunx prisma generate` |

Models added: `AuditLog`, `ProviderConfig`, `ModelPreference`, `StudioSetting`,
`MemoryEntry`, `KnowledgeDoc`, `KnowledgeChunk`, `AutomationSchedule`,
`AutomationRun`.

*Proof:* `db/custom.db` contains the 9 new tables and the 2 pre-existing
`AgenticTask` rows are still there (see TEST_RESULTS §2).

---

## Phase 2 — Security fixes (the defects that mattered)

| # | Defect | Fix | Files |
|---|---|---|---|
| D1 | `POST /api/opencode/execute` had **no** authentication and spawns a child process | `rejectIfUnauthorized` + audit | `src/app/api/opencode/execute/route.ts` |
| D2 | `POST/PUT/PATCH/DELETE /api/agent-registry/*` had **no** authentication | `rejectIfUnauthorized` + audit | `src/app/api/agent-registry/**` |
| D3 | `GET /api/opencode/detect` had **no** authentication | `rejectIfUnauthorized` | `src/app/api/opencode/detect/route.ts` |
| D9 | `spawn()` without an `error` listener → an **uncaught exception** when the binary is missing (the normal case) | resolve the promise on `error` | `src/lib/agentic/opencode.ts` |
| D10 | The approval gate could be **bypassed** by posting an arbitrary `approvedCommands` list | only the engine's `pendingCommand` may be approved | `src/lib/agentic/approvals.ts` (new), `src/app/api/agentic/tasks/[id]/resume/route.ts` |
| D11 | The task cancel route did not stop a running OpenCode child process | `cancelOpenCodeTask(id)` | `src/app/api/agentic/tasks/[id]/cancel/route.ts` |

*Proof:* `tests/api-guards.test.ts` (19 tests) — every route is called with and
without a token and the status codes are asserted.

---

## Phase 3 — Server-side provider configuration

**Problem:** the provider config lived in `localStorage`. There was no
enable/disable, no priority, no timeout/retry policy, no free-only mode and
no encrypted key storage.

| Step | Change | Files |
|---|---|---|
| 3.1 | AES-256-GCM secret storage, key file fallback | `src/lib/agentic/crypto.ts` (new) |
| 3.2 | Provider CRUD, priority, cost class, preferences, settings | `src/lib/agentic/provider-store.ts` (new) |
| 3.3 | Policy-aware router (free-only, disabled providers, priority) | `src/lib/agentic/model-router.ts` |
| 3.4 | The router loads the policy + the stored credentials | `src/lib/agentic/orchestrator.ts` |
| 3.5 | DNS-aware SSRF guard + shared connection test | `src/lib/agentic/outbound.ts`, `src/lib/agentic/provider-connection.ts` (new) |
| 3.6 | REST API | `src/app/api/providers/**`, `/api/model-preferences`, `/api/settings` |
| 3.7 | UI panel | `src/components/studio/providers-panel.tsx` (new) |

**Free-only is a hard rule:** a provider whose cost class is `paid` or
`unknown` is never selected while the mode is on, and if no free model
remains the router fails with `no_model_available` — it never silently spends
money.

*Proof:* `tests/provider-config.test.ts` (26), `tests/routing-policy.test.ts`
(12).

---

## Phase 4 — Audit trail

| Step | Change | Files |
|---|---|---|
| 4.1 | Append-only writer with secret redaction; never throws | `src/lib/agentic/audit.ts` (new) |
| 4.2 | Audit the privileged actions | task create/run/resume/cancel/rollback, tool invoke, provider change, agent registry, memory/knowledge/automation writes |
| 4.3 | Reader + filter API | `src/app/api/audit/route.ts` (new) |
| 4.4 | UI panel | `src/components/studio/audit-panel.tsx` (new) |

*Proof:* `tests/subsystems.test.ts` → "audit trail" (5 tests) — a secret in the
details never reaches the database.

---

## Phase 5 — Memory, knowledge, automation

| Step | Change | Files |
|---|---|---|
| 5.1 | Memory: user scope vs. task scope, credential refusal | `src/lib/agentic/memory.ts` (new) |
| 5.2 | Knowledge: import, chunking, lexical retrieval with sources, binary refusal | `src/lib/agentic/knowledge.ts` (new) |
| 5.3 | Automation: schedules (created disabled), duplicate-run prevention, cancel | `src/lib/agentic/automation.ts` (new) |
| 5.4 | APIs | `/api/memory`, `/api/knowledge`, `/api/knowledge/search`, `/api/automation/**` |
| 5.5 | UI panels | `memory-panel.tsx`, `knowledge-panel.tsx`, `automation-panel.tsx` (new) |

*Proof:* `tests/subsystems.test.ts` (32 tests).

---

## Phase 6 — Unified status, permissions, dashboard

| Step | Change | Files |
|---|---|---|
| 6.1 | One health snapshot (database, python, providers, tools, security) | `src/app/api/system/status/route.ts` (new) |
| 6.2 | The permission policy, derived from the enforcing code | `src/app/api/system/permissions/route.ts` (new) |
| 6.3 | Liveness probe (unauthenticated, 503 when the DB is down) | `src/app/api/health/route.ts` (new) |
| 6.4 | API surface index | `src/app/api/route.ts` (was `Hello, world!`) |
| 6.5 | UI panels | `system-panel.tsx`, `dashboard-panel.tsx` (new) |

---

## Phase 7 — Agent roles

`AgentRole` had only 4 values while the concept needed 8.

| Role | What it does | Step kind |
|---|---|---|
| Planner | produces the plan | — |
| Coder | writes the code | `implement` |
| Tester | proves it with real commands | `test` |
| Reviewer | final PASS/FAIL verdict | `review` |
| **Researcher** | read-only investigation with file:line evidence | `research`, `analyze` |
| **Debugger** | root cause first, then the minimal fix | `debug` |
| **Security Reviewer** | finds secrets / traversal / injection issues, writes a report | `security` |
| **Documentation Agent** | writes the README and the API docs | `docs` |

Files: `src/lib/agentic/roles.ts`, `src/lib/agentic/agent-config.ts`,
`src/lib/agentic/types.ts`, `src/lib/agentic/scheduler.ts`,
`src/lib/agentic/orchestrator.ts`, `src/components/studio/agentic-panel.tsx`.

*Proof:* `tests/routing-policy.test.ts` → "agent roles" (6 tests).

---

## Phase 8 — Windows-first operation

| Step | Change | Files |
|---|---|---|
| 8.1 | One-shot setup (toolchain, install, `.env` with generated secrets, `db push`, tests) | `scripts/windows/setup.ps1` (new) |
| 8.2 | Dev / prod launchers (the prod one resolves `DATABASE_URL` to an absolute path) | `scripts/windows/start-dev.ps1`, `start-prod.ps1` (new) |
| 8.3 | Health check with exit codes | `scripts/windows/health-check.ps1` (new) |
| 8.4 | Build pipeline | `scripts/windows/build.ps1` (new) |
| 8.5 | Guide + troubleshooting table | `docs/WINDOWS_SETUP.md` (new) |
| 8.6 | The batch file prefers bun and falls back to npm | `../start-studio.bat` |

---

## Phase 9 — Configuration & observability

| Step | Change | Files |
|---|---|---|
| 9.1 | Boot-time env validation (never throws, always reports) | `src/lib/agentic/env.ts` (new) |
| 9.2 | The Next.js instrumentation hook reports it at boot | `src/instrumentation.ts` (new) |
| 9.3 | The report is in the status API and in the System panel | `src/app/api/system/status/route.ts`, `system-panel.tsx` |
| 9.4 | `.env.example` documents every variable | `.env.example` |
| 9.5 | The browser sends the API token when the server requires one | `src/lib/api-token.ts` (new) + System panel field |

---

## Phase 10 — Next.js 16 housekeeping

| Step | Change | Files |
|---|---|---|
| 10.1 | `middleware.ts` → `proxy.ts` (the file Next 16 expects) | `src/proxy.ts` (new), `src/middleware.ts` (deleted) |
| 10.2 | The rate limiter also covers `/api/providers` | `src/proxy.ts` |

*Proof:* the build output shows `ƒ Proxy (Middleware)` and no deprecation
warning.

---

## Phase 11 — Tests

| File | Tests | Covers |
|---|---|---|
| `tests/subsystems.test.ts` | 32 | memory, knowledge, automation, audit, env validation |
| `tests/provider-config.test.ts` | 26 | crypto, provider CRUD, cost class, policy, preferences |
| `tests/api-guards.test.ts` | 19 | every guarded route, the approval gate |
| `tests/routing-policy.test.ts` | 12 | free-only, disabled providers, priority, the 8 roles |
| existing 9 files | 123 | the original engine (unchanged) |

---

## Execution order that was used

```
1. audit the repo            → docs/COMPLETION_AUDIT.md
2. schema + db push          → 9 models
3. crypto, provider store, router policy
4. security fixes (D1-D3, D9-D11)
5. audit writer + reader
6. memory, knowledge, automation
7. status, permissions, health
8. new agent roles
9. UI panels + studio shell
10. env validation + instrumentation
11. proxy.ts rename
12. Windows scripts + guide
13. tests
14. final: typecheck, lint, test, build, production smoke test
```

Each step was followed by `bun run typecheck` and `bun test`; the final pass
also ran `bun run lint` and `bun run build`.
