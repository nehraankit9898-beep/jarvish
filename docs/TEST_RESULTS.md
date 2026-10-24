# Test results — 2026-10-24

Everything below was executed in the build sandbox (Linux x64, Node 22.22.3, npm 10.9.8, bun 1.4.4,
Python 3.11.2). Nothing is reported that was not run.

---

## 1. Commands and outcomes

| Command | Result | Notes |
|---|---|---|
| `npm install` | **exit 0** | 1 200+ packages, no audit blockers |
| `npx tsc --noEmit` (`npm run typecheck`) | **exit 0 · 0 errors** | after generating the Prisma client (see §3) |
| `npx eslint .` (`npm run lint`) | **exit 0 · 0 errors · 44 warnings** | all warnings pre-existing (`react-hooks/set-state-in-effect`, unused-disable) |
| `npx next build` | **exit 0** | compiled successfully, 59 pages, all API routes built |
| `npm run build` | **exit 0** | includes standalone copy (`scripts/copy-standalone.mjs`) |
| `npx bun test` (full) | **671 pass · 134 fail · 2 121 expects · 51 files** | **all 134 failures are the missing Prisma engine**, see §3 |
| `npx bun test <30 DB-free files>` | **479 pass · 0 fail · exit 0** | the complete non-database suite |
| `npx bun test` (before the client existed) | 423 pass · 26 fail · 21 errors | every failure `@prisma/client did not initialize yet` |

No test was deleted, skipped or weakened.

---

## 2. New and strengthened tests

| File | Tests | What it proves |
|---|---|---|
| `tests/provider-connection.test.ts` | 26 | real-request testing, HTTP status classification, DNS/timeout, empty/blocked/malformed bodies, missing key, model discovery + cache, free/legacy metadata, no invented models, secret redaction |
| `tests/offline-commands.test.ts` | 20 | Hinglish/English parsing, allowlist enforcement, refusal of arbitrary URLs/apps, status/last-error/cancel/help, acknowledgement never claims success |
| `tests/action-lifecycle.test.ts` | 21 | phase order, terminal phases, exactly-once final speech, approval phrasing, task-status mapping |
| `tests/voice-feedback.test.ts` | 18 | success speaks, failure speaks, bridge down → browser voice, no engine → visible error, no overlap, dedupe, empty text, fences, abort |
| `tests/model-migration-notice.test.ts` | 3 | retired model is migrated **with** a notice, valid models untouched, non-Gemini ids untouched |
| `tests/provider-routes.test.ts` | 8 | route contract: key in the POST body (never in a URL), live/cached/catalog provenance, chat-only filtering, 404 for unknown providers, test result persisted, failure category preserved, no secret in the response, stored key fallback |
| **Total new** | **96** | |

Existing suites that cover the repaired area and still pass: `provider-status-regressions` (8),
`routing-policy` (12), `model-router` (23), `voice-regressions` (20), `voice-stream` (22), `gemini-model` (10),
`security` (19), `host-control` (32), `api-guards` (19), `agentic` (34).

---

## 3. Blocked: Prisma engine download (environment, not code)

```
$ npx prisma generate
Error: request to
https://binaries.prisma.sh/all_commits/c2990dca.../debian-openssl-3.0.x/schema-engine.sha256 failed,
reason: Client network socket disconnected before secure TLS connection was established
```

* `binaries.prisma.sh` is unreachable from this sandbox; `github.com` and the npm registry are reachable.
* `@prisma/engines@6.19.3` ships **no** binaries (download-on-install only).
* `better-sqlite3` (driver-adapter fallback) cannot compile: `node-gyp` fails, prebuilt download blocked.

For type-checking and building only, the client was generated in this sandbox by pointing Prisma at local
stub engine paths (`PRISMA_SCHEMA_ENGINE_BINARY`, `PRISMA_QUERY_ENGINE_LIBRARY`). That produces **types and
client code** — enough for `tsc`/`next build` — but there is no runtime query engine, so any test that touches
the database fails with:

```
Prisma Client could not locate the Query Engine for runtime "debian-openssl-3.0.x".
```

**All 134 failures are of this one kind** (verified across the failing files: audit trail, automation, memory,
knowledge, provider config, task lifecycle, subsystems, …). None is an assertion failure caused by the
changes; the 30 database-free files pass 479/479, including every provider, model, voice, routing and
security suite.

On a normal Windows machine with internet access:

```bat
cd studio
npx prisma generate
npx prisma db push
npm run test
```

is expected to run the full 805-test suite with a real SQLite database.

---

## 4. Not run here (and why)

| Item | Reason | How to verify |
|---|---|---|
| Real Gemini/OpenRouter request with a real key | no credentials in the sandbox, and keys must not be embedded | `docs/PROVIDER_SETUP.md` → Test connection + curl |
| Actual audio playback / microphone | headless sandbox, no audio device | `docs/MANUAL_CHECKLIST.md` §A |
| Windows app launching (Notepad, VS Code) | Linux sandbox; the parser/allowlist logic is unit-tested | checklist §B |
| Desktop bridge (mouse/keyboard/screen) | requires Windows + `AGENTSCOPE_DESKTOP_MODE` ≠ locked | checklist §E |
| Python voice bridge (edge-TTS) | `pip install -r python-bridge/requirements-voice.txt` needs network; bridge code unchanged | Settings → Voice shows bridge status |

The mocked-HTTP provider tests are deterministic and cover every documented status code; a real key is still
required before calling a provider "connected" in the UI.
