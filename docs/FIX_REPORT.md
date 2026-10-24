# JARVIS / AgentScope — Provider, Model & Voice Fix Report

**Date:** 2026-10-24
**Scope:** bug-fix + integration only. No redesign, no feature expansion, no replacement of working modules.
**App:** `studio/` (Next.js 16 · React 19 · Prisma/SQLite). `agentscope/` is vendored upstream Python and was not modified.

This report lists every defect that was reproduced, the root cause, and the change that fixed it.
Line numbers refer to the **repaired** files.

---

## 0. Prioritized bug list (reproduced before editing)

Severity: **P0** breaks the primary promise (connect / speak), **P1** produces a wrong or unsafe state,
**P2** degrades clarity.

| # | Sev | Symptom | Evidence in the code before the fix |
|---|---|---|---|
| 1 | **P0** | Gemini never connects | `providers.ts` defaulted to `gemini-2.0-flash`, a family shut down by Google on 2026-10-20 → every request 404 |
| 2 | **P0** | OpenRouter never connects on the free plan | the catalog's default pointed at a retired free Gemini variant; fallback could pick a **paid** model |
| 3 | **P0** | "Connected" without a working connection | success was decided by HTTP status; blocked/empty/malformed bodies counted as OK |
| 4 | **P0** | JARVIS silent by default | `useSpeechOutput` initialised `enabled = false` and did not persist the toggle |
| 5 | **P0** | Actions ran without a spoken outcome | `runAsTask()` wrote an acknowledgement to the transcript but never spoke it; nothing spoke the terminal result |
| 6 | **P0** | Voice failures disappeared | `runSpeechChain` returned silently when the bridge and the browser voice were both unavailable |
| 7 | **P0** | No offline mode | `grep -ri offline studio/src/lib` matched only docs/voice-wake — no deterministic command layer existed |
| 8 | **P1** | Save could erase a stored key | the save payload always included `apiKey`, empty string included |
| 9 | **P1** | Keys could leak into URLs/logs | model discovery accepted `?apiKey=…` |
| 10 | **P1** | "Connected" survived edits | `connected` was a stored boolean with no link to the configuration that was tested |
| 11 | **P1** | Connection results were not stored | the test route returned a result but never recorded `lastTestedAt/lastTestOk/lastError` |
| 12 | **P1** | Stale/retired model rewritten silently | `loadConnections()` mutated the saved model with no notice |
| 13 | **P1** | Model list was static and unlabelled | one array, no source/timestamp; could be mistaken for a live list |
| 14 | **P2** | Model picker offered embeddings/TTS as chat models | no capability metadata |
| 15 | **P2** | "Test voice" did nothing while muted | it called `speak()`, which honours the mute toggle |
| 16 | **P2** | Providers panel had no status detail | no timestamps, categories, free/legacy markers |
| 17 | **P2** | Offline exchanges vanished from history | the offline path never persisted its messages (fixed via `op:'log'`) |

Each row is addressed in the sections below; every claim is backed by a test listed in `TEST_RESULTS.md`.

---

## 1. Why Gemini and OpenRouter did not connect

### 1.1 Gemini — the default model had been shut down by Google

* **Where:** `studio/src/lib/providers.ts` (catalog), `studio/src/lib/llm-core.ts` (request builder)
* **Root cause:** the Gemini entry shipped `gemini-2.0-flash` as the default. That family was shut down by
  Google on **2026-10-20**; every request therefore failed with `404 model not found`. The old code also
  rewrote *some* model ids silently and could report "connected" when the API responded `200` with an empty
  candidate list.
* **Fix:**
  * catalog refreshed to the live IDs (`gemini-3.8-flash` default, `gemini-3.6-flash`, `gemini-3.5-flash`,
    `gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3-flash`, `gemini-4-argon`), with lifecycle notes;
  * only shut-down families (1.5 / 2.0) are rewritten, and **every rewrite carries a notice** that the UI
    shows *and speaks* (`resolveModelWithNotice`, `X-Model-Notice`);
  * all other ids pass through untouched — a wrong id produces a real `model_unavailable` error instead of a
    fabricated success.
* **Evidence:** `tests/gemini-model.test.ts` (10 pass), `tests/provider-connection.test.ts` — "uses the
  official endpoint, the header key and NEVER the query string", "a blocked prompt is a FAILURE",
  "an empty candidate is a FAILURE", "a retired model is replaced WITH a notice (never silently)".

### 1.2 Gemini — a 200 response was treated as success

* **Root cause:** success was decided by HTTP status alone. A safety-blocked body, an empty `candidates`
  array, or malformed JSON all counted as "Connected".
* **Fix:** `summarizeGeminiResponse()` in `src/lib/provider-errors.ts` distinguishes
  `blocked / empty_response / malformed / auth / model_unavailable / rate_limit / server`; the connection
  test only returns `ok:true` when non-empty provider text came back. Streaming chat applies the same rules.

### 1.3 OpenRouter — the free default model no longer existed

* **Root cause:** the catalog pointed at a free Gemini variant that OpenRouter had already retired. The
  request failed with 404, and the fallback logic could silently move the user to a **paid** model.
* **Fix:** default is now `openrouter/free` (OpenRouter's free auto-router); the live `:free` list is fetched
  from `GET https://openrouter.ai/api/v1/models`; free/paid metadata and capability flags are preserved; a
  paid model is **never** selected automatically and never as a silent substitute. Auth uses
  `Authorization: Bearer`, the official base URL and exact model ids.
* **Evidence:** `tests/provider-connection.test.ts` — "uses the OpenAI-compatible endpoint, the bearer header
  and the exact model id", "402/429 are both a quota problem", "OpenRouter: keeps exact ids + free metadata",
  "the OpenRouter default stays a free target".

### 1.4 Connection errors were collapsed into one message

* **Root cause:** every failure became "Unable to reach the model provider" (or a raw SDK string). A wrong
  key, an unavailable model, a rate limit and a DNS failure were indistinguishable.
* **Fix:** `src/lib/provider-errors.ts` defines 13 categories. `src/lib/agentic/provider-connection.ts`
  classifies HTTP status, provider error bodies, timeouts (`AbortSignal.timeout`), DNS/network errors and
  malformed/empty responses. Each result carries `{ok, error, errorCategory, hint, retryAfterSec, model}` and
  the UI renders the category label + hint + timestamp.
* **Evidence:** `tests/provider-connection.test.ts` — 401/403/404/429/5xx/malformed/DNS/timeout/missing-key
  cases, plus secret redaction.

---

## 2. Why JARVIS was often silent, and why actions had no spoken status

### 2.1 Speech was OFF by default

* **Where:** `studio/src/hooks/use-speech.ts`
* **Root cause:** `useSpeechOutput()` initialised `enabled = false` and never persisted the choice. Unless the
  user found the speaker toggle, every acknowledgement and result was silent — exactly the reported symptom.
* **Fix:** speech defaults **on** when the browser supports it, the choice is persisted under
  `agentscope-tts-enabled`, and users who mute it are told that spoken replies are off.

### 2.2 Speech failures were swallowed

* **Root cause:** when the server voice bridge was down *and* `speechSynthesis` was unavailable, the hook set
  `speaking` back to `false` and stopped. Nothing was shown, nothing was spoken, no error was reported.
* **Fix:** `runSpeechChain()` now reports a visible error on every dead end ("Voice unavailable: …"), the
  audio element's `onerror` and the utterance's `onerror` both set a message, and the dashboard shows a
  dismissible banner. `testVoice()` forces audio even while muted; `speakEssential()` guarantees a final
  status is voiced.

### 2.3 No lifecycle — an action could start and finish without a word

* **Where:** `src/lib/action-lifecycle.ts` (new), `src/components/studio/studio.tsx`
* **Root cause:** `runAsTask()` logged "Samajh gaya…" into the transcript but never spoke it, and nothing ever
  spoke the **final** outcome. Tasks were only visible in the Agentic panel.
* **Fix:** a single lifecycle — `received → understood → running → succeeded | failed | cancelled` — with
  Hinglish sentences and a `TerminalSpeechGate` that guarantees the terminal phase is announced **exactly
  once** per action id (no duplicates when polling and the SSE stream both report it). `watchTask()` now
  speaks the ack, announces approval requests once, and speaks the terminal result with the real error text.
  A 30-minute ceiling stops a stuck task from polling forever and reports a timeout instead of silence.

### 2.4 Streaming replies overlapped the acknowledgement

* **Root cause:** `speak()` could start a second utterance while the previous one was playing; the sentence
  chain had no ownership of "who is allowed to touch the speaker state".
* **Fix:** every new utterance/stream calls `stopSpeaking()` first (one queue, no overlap), a stale session is
  fenced by a sequence number, identical sentences are synthesised once per session, and `abort()` drops both
  the queue and the in-flight request. Covered by `tests/voice-feedback.test.ts` (18 pass).

---

## 3. Offline mode did not exist

* **Root cause:** there was no deterministic command layer at all (`grep -ri offline src/lib` matched only
  documentation/voice-wake code), so "open YouTube" with no API key reached the AI path and failed silently
  after a network error.
* **Fix:** three new modules + one route branch:
  * `src/lib/agentic/offline-commands.ts` — parsing for *open site*, *open app*, *status*, *last error*,
    *cancel*, *help*; unknown input returns `matched:false` so normal chat is never hijacked;
  * `src/lib/agentic/offline-runner.ts` — executes through the **existing** `requestHostAction` approval
    system (no shell, allowlisted targets only) and writes an audit entry;
  * `POST /api/jarvis {op:'command'}` — no cloud API needed;
  * `studio.tsx` — tries the offline path before `/api/chat`, appends the exchange to the transcript,
    persists it via `op:'log'`, and speaks one combined sentence: acknowledgement + real outcome.
* **Evidence:** `tests/offline-commands.test.ts` (20 pass), `tests/action-lifecycle.test.ts` (21 pass).

---

## 4. Settings, keys and status

| Defect | Root cause | Fix |
|---|---|---|
| "Connected" survived a changed key/model | `connected` was a saved boolean | `connectionSignature()` + `isVerified()`. Connected is shown only when the **current** draft matches the configuration that passed a real test; editing any field invalidates it |
| Save could wipe a stored key | empty key field was sent as a value | the UI omits the key unless non-empty; `saveProvider()` keeps the stored `apiKeyEnc` |
| Keys travelled in URLs | model discovery passed `?apiKey=` | new `POST /api/providers/[id]/models` carries the unsaved key in the body; keys are never returned by any route (only `hasKey`/`keyHint`) |
| Test result was not persisted | route returned the result but never stored it | route now calls `recordConnectionResult()` + `recordLastError()`; panel shows timestamp, category and sanitized error |
| A stale model id in the browser was rewritten silently | `loadConnections()` mutated the model | it now queues a `ModelMigrationNotice`; the app shell toasts **and speaks** "purana model X ab supported nahi hai, isliye Y set kar diya" |
| Model list could be shown as live when it was static | one `models` array, no provenance | list carries `source: provider \| cache \| catalog`, `fetchedAt`, `cached`, `note`, `selectedNotice`; the UI labels it and marks free/legacy items |
| Test Voice did nothing while muted | it called `speak()`, which respects mute | calls `testVoice()` (forces audio), shows the engine, the last spoken line and any error |

---

## 5. Repaired / added files

**Added**

```
studio/src/lib/provider-errors.ts            error taxonomy, sanitizer, spoken sentences
studio/src/lib/action-lifecycle.ts           phases, Hinglish sentences, TerminalSpeechGate
studio/src/lib/agentic/offline-commands.ts   deterministic command parser
studio/src/lib/agentic/offline-runner.ts     safe execution through the approval system
studio/src/lib/agentic/last-action-error.ts  "repeat the last error" memory
studio/src/app/api/providers/[id]/models/route.ts
studio/tests/provider-connection.test.ts     (26)
studio/tests/offline-commands.test.ts        (20)
studio/tests/action-lifecycle.test.ts        (21)
studio/tests/voice-feedback.test.ts          (18)
studio/tests/model-migration-notice.test.ts  (3)
studio/tests/provider-routes.test.ts         (8)
```

**Modified**

```
studio/src/lib/providers.ts                     catalog, legacy ids, notices
studio/src/lib/llm-core.ts                      SSE parsing, Gemini blocks, sanitized errors
studio/src/lib/agentic/provider-connection.ts   real-request tester + live discovery + cache
studio/src/lib/agentic/provider-store.ts        connection result persistence plumbing
studio/src/app/api/chat/route.ts                categorized failures, model notice, no fake success
studio/src/app/api/test-connection/route.ts     persist + classify
studio/src/app/api/providers/[id]/test/route.ts persist + classify + sanitize
studio/src/app/api/providers/[id]/models/route.ts  POST + provenance
studio/src/app/api/jarvis/route.ts              op:'command' (offline path)
studio/src/lib/api-keys-store.ts                verification signature, migration notice
studio/src/hooks/use-speech.ts                  default-on, testVoice, visible errors, no overlap
studio/src/components/studio/studio.tsx         lifecycle speech, offline path, spoken failures
studio/src/components/studio/settings-dialog.tsx verified state, server-side keys, live models
studio/src/components/studio/providers-panel.tsx status badges, timestamps, provenance
studio/src/components/jarvis/jarvis-dashboard.tsx voice banner + transcript
studio/src/components/jarvis/jarvis-settings.tsx  Test Voice + error + last spoken
```

**Deliberately untouched:** approval/host-control internals, tool allowlists, orchestrator, scheduler,
Prisma schema, the Python bridge, and the overall UI layout.

---

## 6. Behaviour you should see after the fix

* With a valid Gemini key, **Test connection** returns
  `Connected — verified with a real request … model: gemini-3.8-flash`.
* With a wrong key it says `Authentication failed` and shows the provider's sanitized message — the key is
  never echoed.
* With the retired `gemini-2.0-flash` saved, the UI announces the migration once and uses `gemini-3.8-flash`.
* Saying "YouTube kholo" speaks *"Haan, main aapki command samajh gaya. YouTube successfully open ho gaya."*
  (or the real failure) even with no API key.
* Every agentic task gets an acknowledgement, a start announcement and exactly one final sentence.
* If no voice engine can speak, the dashboard shows a red "voice unavailable" banner instead of pretending.
