# JARVIS-v3 → AgentScope Studio Integration Report

**Date:** 2026-10-24 · **Task:** integrate the JARVIS-v3 futuristic command-center UI into the existing AgentScope Studio without rebuilding the app or touching the engine.

---

## 1. Files changed and why

### New files — the JARVIS layer (`studio/src/components/jarvis/`)

| File | Purpose |
|---|---|
| `jarvis-reactor.tsx` | The central arc reactor as a **pure 2D `<canvas>`** (deliberate: the reference inlines 603 KB of three.js; the task mandates lightweight). Recreates the reference scene — glow halo, fresnel core, 4 gyro rings, 2 dashed tick rings, 3 HUD arcs, 150 dust particles, floor hologram — with the same state colors (`idle #1fd4ff · listening #38ffb0 · thinking #ffc247 · speaking #9fe8ff · error #ff7b7b`) and the same per-frame lerp model (0.06). One RAF loop, DPR cap 2, pauses on tab-hide, honors `prefers-reduced-motion`. While listening it opens a **real** `getUserMedia` + `AnalyserNode` RMS loop (noise gate 0.012) so the reactor genuinely reacts to the mic; if mic access fails it falls back to a synthetic pulse and the mic button surfaces the real error. |
| `jarvis-dashboard.tsx` | The JARVIS home mode: reactor backdrop + scanlines/vignette, real stats meters (uptime/DB/tools from `GET /api/system/status` + `/api/health`), UPLINK provider panel (`GET /api/providers`, 30 s), realtime activity (task SSE + `GET /api/audit`), current-task card with SSE live progress (`GET /api/agentic/tasks/{id}/stream`, reconnecting, seq-dedup — same contract as `agentic-panel.tsx`), **command approvals** (`POST /api/agentic/tasks/{id}/resume {approvedCommands:[cmd]}` — identical payload to the agentic panel), **host approvals** (`GET /api/host` 5 s poll + `POST /api/host {op:'approve'\|'deny'}`), **kill-switch banner** (`GET /api/laptop` + `POST {op:'resume'}`), transcript (same conversation state as Chat mode), chips, and the HUD composer (mic / lang / TTS / LIVE / stop / send). |
| `jarvis-settings.tsx` | "SYSTEM CONFIG" modal with 4 tabs — **AI Brain** (13-provider grid, key + model + base URL, `POST /api/test-connection` with visible errors, Save & Use, Remove — same localStorage connection store as the classic dialog), **Voice** (TTS toggle + real bridge status from wake poll, mic language, test voice), **Listening** (wake word toggle + sensitivity + real openWakeWord engine status, LIVE availability), **Routing** (`GET/POST /api/settings`: free-only / prefer-free / auto-fallback / default provider + effective routing order from `GET /api/providers`). |
| `jarvis-boot.tsx` | Session-only boot overlay. The staged lines are **real check results** (`/api/health`, `/api/system/status`, `/api/providers`); skippable (Esc/Skip); persisted in `sessionStorage`. |

### Modified files

| File | Change |
|---|---|
| `src/app/globals.css` | Added the `.jarvis-scope` theme: Tailwind v4 palette overrides (zinc→deep-navy ramp, emerald→JARVIS cyan, hue tuning for sky/green/red/amber) + shadcn semantic tokens + state-driven `--jv-accent` variables swapped by `[data-jarvis-state]` + HUD primitives (`jv-panel`, `jv-hud-label`, `jv-brand`, `jv-scanlines`, `jv-vignette`) + keyframes (blink/breathe/mic-pulse/fade-up) + scrollbars + reduced-motion guards. **This single scope re-skins all 25 existing panels without touching their code.** |
| `src/app/layout.tsx` | `jarvis-scope` class on `<html>` (so Radix portals inherit the theme), Orbitron display font for the brand, updated metadata. |
| `src/components/studio/studio.tsx` | Added `'jarvis'` mode (now the landing mode) + all 16 modules in a **collapsible HUD navigation rail**; JARVIS HUD top bar (live status pill bound to the reactor state machine, clock, provider dropdown, python badge, bell, Config); reactor state machine (`idle/listening/thinking/speaking/error` — derived from real state: voice.listening, chat streaming, task running, tts.speaking, transient error flashes on real chat/task failures) mirrored to `data-jarvis-state` on `<html>`; **LIVE voice loop** (continuous listen→send→speak through the existing backend; auto-stops when leaving the JARVIS screen or when TTS is talking); `sendMessage(text?)` override for the LIVE loop; task handoff stays on the JARVIS screen (dashboard shows live progress); JarvisBoot + JarvisSettings mounted; 15 s task-list poll keeps the status pill honest. **Every existing handler, endpoint call, agent/conversation/task list, and the classic chat composer are preserved.** |
| `tsconfig.json` | Excluded sandbox-only `examples/`, `skills/`, `extracted/` folders (not part of the AgentScope Studio project; they broke the build's TS pass with out-of-project demo code). |

### New docs
`docs/PHASE1_AUDIT.md` (pre-implementation audit: feature→UI→endpoint map, port matrix, risks) and this report.

### Untouched (verified)
All API routes, `src/lib/agentic/**` (orchestrator, permissions, approvals, secrets, audit, kill switch, voice bridge, model router), prisma schema, python-bridge, worker, all 25 classic panels, `hooks/use-speech.ts`, `lib/providers.ts`, `lib/api-keys-store.ts`. **Zero new runtime dependencies.** The only backend-adjacent change is the tsconfig exclude list.

## 2. Features implemented vs unsupported

### Implemented (all bound to real backend)
- JARVIS home with animated arc reactor + scanlines/vignette + boot sequence with real system checks
- Status-dependent reactor + HUD colors: idle cyan / listening green / thinking amber / speaking light-blue / error red
- Initialize/Connect: boot overlay + provider uplink panel + Config dialog
- Microphone + text command input routed through the existing Jarvis intent engine (`/api/jarvis` op:'intent') → chat (`/api/chat` stream) or agentic task (`/api/agentic/tasks` + run)
- Start/stop listening (Web Speech, hi-IN/en-IN), LIVE continuous voice loop, wake word ("Hey Jarvis" via openWakeWord bridge)
- Stop/interrupt (aborts chat stream + stops TTS), task cancel (`POST .../cancel`)
- Conversation transcript persisted server-side; current-task card with SSE live progress and step counter
- Active provider/model status; per-provider uplink dots (enabled/configured/last-test) — no faked availability
- Pending approvals: task command approvals AND host (laptop) approvals with Approve/Deny; kill-switch banner with Resume
- Realtime activity feed (live task events + audit trail)
- Settings dialog: providers/keys/test-connection, voice prefs, wake-word status, routing policy (free-only etc.)
- Full navigation to all 15 existing modules (Chat, Agentic, Agents registry, Compare, Tools, Providers, Memory, Knowledge/RAG, Automation, Goals, Laptop control, Browser, Audit, System, Home dashboard)

### Explicitly unsupported / honest states
- **Native Gemini Live (WebSocket BidiGenerateContent)** — the reference drives it with a raw client-side API key, which bypasses the Studio's server-side key storage and model router. Not integrated; the LIVE toggle instead provides a provider-agnostic continuous voice loop through the existing secured backend. This is stated in the settings UI.
- **Mic transcription** — no server-side STT exists in the project; stays browser-side (Web Speech API). Requires Chrome/Edge + HTTPS or localhost; other browsers show an explicit unsupported state and the LIVE chip renders "LIVE (no mic)".
- **Voice bridge (edge-tts/wake)** — requires `pip install -r python-bridge/requirements-voice.txt`; when offline the UI shows the real status and falls back to browser TTS (existing behavior).
- **Reactor mic-reactivity** — needs mic permission; without it the reactor pulses synthetically and never fakes "listening".

## 3. Tests actually executed and real results

| Check | Command | Result |
|---|---|---|
| Unit/integration suite | `bun test` | **402 pass / 0 fail** (23 files). The README's "804" figure is the same 402 tests counted twice because the sandbox working copy initially contained a duplicate `extracted/` mirror; after removing the mirror: 402/402. One environment-sensitive test (`project index > a huge tree is truncated`) timed out only while a browser session was polling the dev server concurrently and passes in isolation. |
| TypeScript | `bunx tsc --noEmit` | **0 errors** in all project sources (pre-existing errors only in sandbox `examples/`+`skills/` demo folders, now excluded from the project scope). |
| ESLint | `bun run lint` | **0 errors** (6 pre-existing "unused eslint-disable directive" warnings in original files). |
| Production build | `bunx next build` | **Compiled successfully** — full route table emitted (47 API routes + pages). One fix was needed: Orbitron is a variable font and `weight: [...]` crashed the Turbopack font resolver — removed the weight list. |
| API integration | curl + browser network log | `/api/health` 200 · `/api/providers` 200 · `/api/system/status` 200 · `/api/jarvis` intent+log 200 · `/api/chat` streamed a real reply (Z.ai glm-4.6) · `/api/agentic/tasks` + `/run` created and completed a real task · `/api/host` deny + approve verified server-side · `/api/laptop` kill + resume verified · `/api/settings` GET/POST via Routing tab. |
| Browser smoke (agent-browser, 18 screenshots) | Chromium | Boot → INITIALIZE → real check lines; dashboard meters populated from live APIs; real chat round-trip rendered in the transcript with typing dots; status pill cycled STANDBY→PROCESSING→STANDBY in sync with the stream; **real agentic task**: "create hello.py and run it" → planner ack → task card showed live progress → `done`, server report: `1 file changed, python3 hello.py → exit=0`, progress 2/2 steps 100%; host approval Deny reduced pending count server-side; kill switch: banner appeared within the poll window, Resume via UI set `killed:false`; classic Chat mode still renders full history; Agentic panel renders untouched; Config dialog tabs (AI Brain / Voice / Listening / Routing) render real data; mobile (390×844) layout stacks correctly. |
| Console errors | `agent-browser errors` | None. |

## 4. Build failures encountered and remaining bugs

| Issue | Status |
|---|---|
| `next/font/google` Orbitron weight-array crash ("next/font/google queries have exactly one entry") | **Fixed** (variable font → no weight list). |
| Build TS pass failed on `examples/websocket/*` (sandbox demo code, not project code) | **Fixed** by excluding sandbox-only folders in tsconfig. |
| Boot overlay deadlock: Esc-handler effect re-ran on every parent re-render (1 Hz clock) and cleared the pending boot timers | **Found via browser testing, fixed** (ref-stabilized mount-only effect); re-verified. |
| Status pill stayed amber after a task finished (stale task list) | **Fixed** with a 15 s task-list poll; verified pill returns to STANDBY. |
| Known environment quirk: the huge-tree indexing test times out when a browser session polls the dev server concurrently (5 s limit, heavy I/O) | Not a product bug — passes in isolation; noted for honesty. |
| Remaining known limitation: LIVE loop and wake word are mutually exclusive by design (one recognition stream), same as the original Chat composer. | Documented, unchanged behavior. |

## 5. Exact Windows launch commands

```powershell
# One-time setup (from the agentscope-suite folder)
cd agentscope-suite\studio
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1     # installs deps + prisma

# Every day
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1  # http://localhost:3000

# Manual alternative
cd agentscope-suite\studio
npm install          # or: bun install
npx prisma db push
npm run dev

# Optional checks
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm test                 # bun test
npm run build            # production build (next build)
npm run health           # health-check script

# Optional: real AgentScope Python engine + voice
pip install -e ..\agentscope
pip install -r python-bridge\requirements-voice.txt    # edge-tts + wake word
# restart the Studio — the header badge shows 🐍 AgentScope: v2.0.10
```

Then open **http://localhost:3000** → the JARVIS command center boots (INITIALIZE). "API Setup" chip → pick a provider (Z.ai works out of the box in this sandbox build; Gemini/OpenRouter/Ollama keys via the same dialog).

## 6. Safety verification summary

- Approval gates: task command approvals use the exact `/resume {approvedCommands:[...]}` payload the original panel sends (server validates exact-command match); host approvals use `/api/host {op}`; the browser cannot swap the stored action.
- Kill switch: engage/release verified live; banner reflects the real flag; all laptop actions remain refused while engaged (engine-enforced, unchanged).
- Secrets: API keys stay in localStorage (browser flow) or AES-256-GCM server-side (Providers panel); the settings dialog never echoes stored keys; `x-agentscope-token` still attached by the existing fetch wrapper.
- Database schema: unchanged. No migrations. No new dependencies.
