# FEATURE_STATUS.md — AgentScope Suite · JARVIS v2.1

Honest classification of what exists in the code today, what was exercised in this environment, and
what is explicitly **not** verified here. Statuses:

| Status | Meaning |
|--------|---------|
| **IMPLEMENTED** | Real code path, no mock, covered by at least one automated test **and** (where possible) exercised live in this pass. |
| **PARTIAL** | Works, but a dependency (credential, model quality, OS feature) or a sub-feature is missing. |
| **BLOCKED** | Code exists and is complete, but cannot run without something this sandbox cannot provide (Windows, microphone, browser, outbound network, API key). |
| **MISSING** | Not implemented (and deliberately not added here). |

---

## 1. The JARVIS product surface

| Feature | Status | Evidence / limits |
|---------|--------|-------------------|
| JARVIS dashboard (`/`) — reactor, HUD, transcript, approvals, kill banner, live task panel | **IMPLEMENTED** (server side) / **UNVERIFIED visually** | SSR of `/` returns 200 with the JARVIS shell; every data source it polls answers (`/api/health`, `/api/system/status`, `/api/providers`, `/api/host`, `/api/laptop`, `/api/audit`, `/api/agentic/tasks/<id>` + its SSE stream). No browser was available, so the rendered pixels were not reviewed. |
| Dashboard truthfulness | **IMPLEMENTED** | Fixed here: the task SSE stream now opens immediately (the panel used to sit on "connecting" for the whole quiet period). Failure states are real (`connectionError` on a failed fetch; "Database unavailable" / "API access denied" are derived from actual status codes). |
| Chat with any configured provider (streaming) | **IMPLEMENTED** | `buildUpstreamStream()` for openai-compatible / anthropic / gemini / Z.ai; SSE parsing fixed here (trailing frame was lost); provider failures are now reported accurately (401/404/5xx). **Live provider calls unverified** (no keys, no outbound HTTPS). |
| Persona / character selection (5 personas + avatar) | **IMPLEMENTED** | `persona.ts` (jarvis, friday, buddy, mentor, professional), persisted through `/api/persona` (live round-trip verified); `jarvis-avatar.tsx` is a pure SVG/CSS face themed by persona hue, gender and voice state — no image assets, no fake 3D. Avatar *rendering* unverified (no browser). |
| Voice: browser recognition → chat → TTS | **PARTIAL** | Recognition/TTS fall back to the browser (`use-speech.ts`); the server TTS route returns `503 {"error":"No module named 'edge_tts'","fallback":"browser"}` here — an honest degradation, and the client falls back. `use-speech` regression suite covers duplicate transcripts, stuck `speaking`, wake dedupe, sentence chaining. **Not** verified with a real microphone. |
| Wake word ("Hey Jarvis") | **BLOCKED** | Server-side engine via the Python bridge; `openwakeword` is not installed here (`engine: "none"`, `engine_detail: "No module named 'openwakeword'"`). The bridge answers and reports status honestly. Install `python-bridge/requirements-voice.txt` to enable. |
| Memory: durable facts + task notes + recall | **IMPLEMENTED** | Two isolated scopes, upsert dedupe, credential refusal, Hinglish↔English synonym retrieval, transcript recall. Unit-tested (`memory-recall.test.ts`) and exercised live (POST/GET/DELETE). Deletion now requires a target (B-08). |
| Conversation history / rename / delete | **IMPLEMENTED** | Live CRUD verified; auto-title from the first message. |
| Capability answers ("what can you do?") | **IMPLEMENTED** | `JARVIS_CAPABILITIES_PROMPT` injected only for capability questions. |
| Intent router (`/api/jarvis`) | **IMPLEMENTED** | POST-only (GET → 405). |
| Local-first privacy boundaries | **PARTIAL** | Local: SQLite, encrypted keys, every tool, the Python bridges, audit. Cloud (only when configured): the chosen LLM provider (chat, planning, roles, vision), Google (Gmail/Calendar/Drive) if connected, Telegram if configured, GDELT/news for World Monitor, SMTP for e-mail. Screenshots are sent to the vision model **only** for a `mode:'screen'` task, and the task states that in its response. |
| AI model switching, fallback, free-only, quota handling | **IMPLEMENTED** (routing) / **BLOCKED** (live) | `model-router.ts` + `provider-store.ts`: routing order, per-role model preference, `costClass` (free/paid), free-only mode, bounded retries, 429 `Retry-After` handling, provider/model reported in every response. Covered by `model-router.test.ts`, `routing-policy.test.ts`, `provider-config.test.ts`. A live failover needs real keys. |
| Approvals + kill switch | **IMPLEMENTED** | Enforced in the backend (not the UI): 10-minute single-use approvals bound to the stored action, re-classified at execution, cancellation drops pending approvals; kill switch blocks exec/desktop/write/remote and persists across restarts. Verified live (see `TEST_RESULTS.md §3.2`). |
| Audit trail | **IMPLEMENTED** | Every privileged action recorded with masked details; UI tab reads it; **retention is opt-in** (see below). |
| Notifications / suggestions / proactive scans | **IMPLEMENTED** | Prune of read notifications after 30 days. |

## 2. Agentic engine

| Feature | Status | Evidence |
|---------|--------|----------|
| Planner → Researcher → Coder → Debugger → Tester → Security reviewer → Docs → Reviewer | **IMPLEMENTED** | `orchestrator.ts` + `roles.ts`; dependency-aware scheduling, per-step git snapshot + rollback, bounded targeted fixes (max 2/step), `paused` vs `failed`, cancellation of the running process group. |
| Evidence-based completion | **IMPLEMENTED** | `test-gate.ts` rejects a reviewer PASS without executed, passing commands; `finishTask` cannot mark a cancelled/terminal task. Live: a planning failure produced `status=failed`, never `done`. |
| Isolated workspace per task | **IMPLEMENTED** | `.agentic-workspace/<taskId>/`, traversal + symlink escape rejected, workspace lock for writers. |
| Plan validation / dependency repair | **IMPLEMENTED** | `sanitizeStepDependencies`, cycle detection, dangling-edge tolerance. |
| Interrupted-task recovery | **IMPLEMENTED** | Startup recovery parks `running/planning/verifying` tasks as `paused` (resumable); `retry_wait` re-queued; `blocked` re-checked when a credential appears. |
| Screen-awareness (vision loop) | **PARTIAL / BLOCKED** | Real implementation (screenshot → model → approved actions, sensitive-window tripwires, step budget, payment guard). Needs a vision model + a desktop; unverified here. |
| Multi-agent message bus | **IMPLEMENTED** | Persisted, sequenced, visibility rules; `message-bus.test.ts`, `multi-agent.integration.test.ts`. |

## 3. PC control (Windows desktop)

| Capability | Status | Notes |
|------------|--------|-------|
| Run commands / read / write / list / delete / mkdir / open URL / e-mail anywhere | **IMPLEMENTED** (POSIX verified, Windows code reviewed) | All gated by mode + approval + blocklists; live-verified on Linux. Windows `powershell.exe` path is code-reviewed only. |
| Delete to Recycle Bin, downloads, Chrome history, clipboard | **BLOCKED** | Goes through the Python desktop bridge (`pyautogui`/`mss`/`send2trash`), which needs `requirements-desktop.txt` and a real display. |
| Mouse / keyboard / screenshot / windows | **BLOCKED** | Same bridge; `AGENTSCOPE_DESKTOP_MODE=locked` by default. |
| App launch, volume, brightness, power, lock screen | **BLOCKED** | Bridge endpoints; code present, not runnable here. |
| File search / folder creation inside the trusted roots | **IMPLEMENTED** | Workspace + host tools, live-verified. |
| YouTube / music (`music-play`, `music-control`) | **PARTIAL** | Builds a real deep link (`https://www.youtube.com/results?…`, `spotify:search:…`, `whatsapp://send?…`) and media keys via the bridge. Playback/pause cannot be verified without a desktop and a default browser. |
| WhatsApp messaging | **PARTIAL** | Composes a pre-filled message and opens WhatsApp (desktop URI / web) — the user presses Send. There is **no** WhatsApp API integration and none is claimed. |
| Windows installer / tray / scheduled worker | **BLOCKED** | `scripts/windows/*.ps1` and `python-bridge/tray.py` reviewed, not executed (no Windows host). Instructions in `studio/docs/WINDOWS_SETUP.md` and `TEST_RESULTS.md §7`. |

## 4. Browser, knowledge, automation, integrations

| Feature | Status | Notes |
|---------|--------|-------|
| Automation browser (Playwright) with page intel, payment guard, user takeover | **PARTIAL** | Code complete; Chromium cannot be downloaded here, so only unit-level behaviour was exercised. |
| Knowledge base (import, chunk, search, delete) | **IMPLEMENTED** | Live: import → indexed (`chunkCount:1`) → search hit → delete removes chunks. Office/PDF/zip extraction guarded against zip/xlsx/regex blow-ups. |
| Project index / retrieval | **IMPLEMENTED** | `project-index.test.ts`; large-tree test needs a >5 s timeout in this sandbox. |
| Scheduled automation (cron, interval, timezone, misfire recovery, DST) | **IMPLEMENTED** | DST spring-forward verified directly (`2025-03-10T06:30Z`, 9 ms); duplicate-run guard; external worker via `npm run worker`. |
| Background runtime (schedules, recovery, proactive, retention) | **IMPLEMENTED** | Single-instance lock with heartbeat; yields to the standalone worker. |
| World Monitor (hotspots + headlines) | **BLOCKED** (live data) / **IMPLEMENTED** (code) | GDELT + news feeds behind the SSRF guard, cached snapshots, honest "sources down" state. No outbound network here. |
| Phone remote (pairing, chat, TTS, revoke) | **IMPLEMENTED** (server) / **BLOCKED** (real device) | `remote.test.ts` + live `/api/remote/status`. Two-way **audio** is one-way TTS + phone-side recognition; there is no WebRTC full-duplex audio in this build. |
| Google connector (Gmail/Calendar/Drive) | **BLOCKED** | Needs OAuth client id/secret (`docs/GOOGLE_CONNECTOR_SETUP.md`). |
| Telegram control | **BLOCKED** | Needs a bot token; allow-list + kill-switch command implemented. |
| E-mail (SMTP) | **BLOCKED** | Needs `AGENTSCOPE_SMTP_URL`; validation + approval gate implemented. |
| Custom tools (agent-authored, sandboxed) | **IMPLEMENTED** | Live: create → approval → invoke → escape refused. |
| Goals, workflows, recipes, prompt versions, model preferences, agent registry | **IMPLEMENTED** | Unit-tested; REST CRUD live-verified. |
| OpenCode CLI integration | **IMPLEMENTED** (code) / **BLOCKED** (binary) | `{"installed":false}` here; environment sanitised (B-05). |

## 5. What is MISSING on purpose

* **Multi-user accounts / RBAC / SSO.** The product is single-user by design; adding auth providers
  would be a redesign, not a repair.
* **Real WhatsApp Business API / YouTube playback control API.** The shipped behaviour is a deep
  link + media keys, and the docs say so.
* **Full-duplex phone audio (WebRTC).** TTS + phone-side recognition only.
* **Offline speech recognition.** The wake engine is local, but recognition is browser/cloud based;
  no offline claim is made.
* **Destructive tests for the retention sweep.** Disabled by default; see below.

## 6. Known gaps that remain (documented, not hidden)

| Gap | Impact | Where |
|-----|--------|-------|
| Retention has no automated destructive test | The sweep could regress silently; it is off by default and audit-logs itself | `retention.ts` |
| `finishTask()` parses step JSON unguarded (S-01) | A corrupted `commands` column would wedge the report builder | `orchestrator.ts` |
| Audit `ip` is spoofable behind a proxy (S-03) | Rate-limit dodging / audit noise | `audit.ts` |
| CSP allows `unsafe-inline`/`unsafe-eval` (S-07) | Weakens XSS defence; the API token lives in `localStorage` | `next.config.ts`, `api-token.ts` |
| In-memory rate limiter + remote sessions | Not shared across processes; cleared on restart | `proxy.ts`, `remote-session.ts` |
| Windows/desktop/voice-hardware paths | Unverified here — instructions provided instead of claims | `TEST_RESULTS.md §5` |
