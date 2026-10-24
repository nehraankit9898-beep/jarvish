# Phase 1 Audit — JARVIS-v3 → AgentScope Studio Integration

**Date:** 2026-10-24 · **Scope:** pre-implementation audit of both uploaded projects, done before any code change.

## 1. Artifacts inspected

| Artifact | What it is |
|---|---|
| `JARVIS-v3/jarvis.html` | 766 KB single-file app. Lines 1–364 CSS, 366–725 DOM, line 727 = inlined three.js r128 UMD (603 KB, the only dependency), 729–2974 app JS (one IIFE). Byte-identical copy inside `jarvis-desktop/src/index.html` (verified by md5). |
| `JARVIS-v3/jarvis-notes/JARVIS-v3-GUIDE.md` | Feature guide (Hinglish): Gemini/OpenRouter/Ollama providers, Live voice, wake word, skills. |
| `JARVIS-v3/jarvis-desktop/` | Optional Tauri v2 wrapper (Rust). Not used — the Studio is a web app; Tauri adds nothing here. |
| `agentscope-suite/studio/` | Next.js 16.1.1 / React 19 / TS 5 / Tailwind v4 / Prisma 6 + SQLite. 47 API route groups, 25 UI panels, agentic engine in `src/lib/agentic/` (50+ modules), python-bridge, worker. |
| `agentscope-suite/agentscope/` | AgentScope Python framework v2.0.10 source (pip-installable). Untouched by this task. |

## 2. Existing Studio feature → UI → endpoint map (must survive redesign)

| Feature | UI today | Backend |
|---|---|---|
| Chat + streaming | `studio.tsx` chat mode, `chat-message.tsx` | `POST /api/chat` (plain-text chunked stream), `POST/GET/DELETE /api/conversations[/{id}]` |
| Chat vs task routing | `sendMessage` in `studio.tsx` | `POST /api/jarvis` `{op:'intent'}` (rule-based Hinglish/English router, `lib/agentic/jarvis.ts`), `{op:'log'}` persists handoff |
| Agents (chat personas) | sidebar list + `agent-dialog.tsx` | `GET/POST /api/agents`, `PUT/DELETE /api/agents/{id}` |
| AI self-creates agents | `agent-create-card.tsx` via ` ```agentcreate ` block | handled in chat system prompt + `POST /api/agents` |
| Agentic engine (plan → roles → approvals → run) | `agentic-panel.tsx` (SSE live timeline) | `POST /api/agentic/tasks` (planner), `POST .../run {decision,command}` (approvals), `GET .../stream` (SSE, seq-based resume), `pause/resume/cancel/rollback/diff/workspace` |
| Provider config (server, AES-256-GCM) | `providers-panel.tsx` | `GET/POST /api/providers`, `PATCH /api/providers/{id}`, `POST /api/providers/{id}/test`, `GET .../models` |
| Provider config (browser/localStorage) | `settings-dialog.tsx` | `POST /api/test-connection` + `useConnections()` store |
| Routing policy (free-only/prefer-free/fallback, per-role) | `providers-panel.tsx` | `POST /api/settings`, `POST /api/model-preferences` |
| Laptop control + host approvals + kill switch | `laptop-panel.tsx` (3 s poll) | `GET/POST /api/host` (`approve/deny`), `GET/POST /api/laptop` (`kill/resume/...`) |
| Voice input (mic → text) | `useVoiceInput` hook (Web Speech API, hi-IN/en-IN) | browser-side, no server STT |
| Voice output (TTS) | `useSpeechOutput` hook | `POST /api/voice/speak` (edge-tts via python bridge, audio/mpeg) → falls back to `speechSynthesis` |
| Wake word "Hey Jarvis" | `useWakeWord` hook + Radar button | `GET/POST /api/voice/wake` (openWakeWord python bridge; kill-switch aware → 423) |
| Live voice | **not present** in Studio | — (JARVIS ref uses Gemini Live WS directly with a client-side key) |
| Dashboard | `dashboard-panel.tsx` | `GET /api/system/status`, `GET /api/agentic/tasks`, `GET /api/audit` |
| Goals / Automation / Memory / Knowledge / Audit / Browser / Compare / Tools / Agent registry / Connectors / System | their panels | `/api/goals`, `/api/automation`, `/api/memory`, `/api/knowledge`, `/api/audit`, `/api/browser`, `/api/compare`, `/api/tools*`, `/api/agent-registry*`, `/api/connectors`, `/api/system/*` |
| Notifications | `notifications-bell.tsx` (30 s poll) | `GET/POST /api/notifications` |
| Proactive suggestions | `suggestions-card.tsx` | `GET/POST /api/suggestions` |
| Auth | `installTokenFetch()` patches `fetch` → `x-agentscope-token` from localStorage | `lib/agentic/api-auth.ts`: same-origin + token (+fail-closed in production) |
| Safety | approval AlertDialogs (agentic, browser payments), kill switch, audit trail, secret masking | engine-enforced; **UI must not bypass** |

Test baseline before any change: **`bun test` → 804 pass / 0 fail (46 files)**. Dev server boots; `/api/health`, `/api/providers`, `/api/system/status`, `/api/jarvis` all verified responding.

## 3. JARVIS-v3 visual inventory (what we port)

- **Palette:** bg `#020509`, ink `#cfe9f5`, dim `#6e93a6`, panel `rgba(6,17,27,.62)`, state accents — idle cyan `#1fd4ff`, listening green `#38ffb0`, thinking amber `#ffc247`, speaking light-blue `#9fe8ff`, error red `#ff7b7b`. State theming = 3 CSS vars swapped by `body[data-state]` (exact mechanism we adopt).
- **Reactor:** three.js scene — fresnel shader sphere, icosahedron shell, lattice, core+glow sprite, 4 gyro tori, 2 dashed tick rings, 3 HUD arcs, 1500-point dust shell, floor ring. One RAF loop; energy `lerp 0.06`; color lerp per frame; mic RMS → energy; DOM meter writes throttled every 6th frame.
- **HUD DOM:** boot screen with INITIALIZE, top bar (brand + status pill + clock), left stats rail (ARC POWER / NEURAL LINK meters + uptime), bottom console (log, interim line, chips, input row), toasts, settings/help modals, scanlines + vignette overlays.
- **Audio:** Web Audio `AnalyserNode` RMS (noise gate 0.012) drives reactor + barge-in (level > 0.30 for ~100 ms while speaking → stop TTS). Synth beeps via OscillatorNode.
- **Key decision:** the reference inlines **603 KB of three.js**. Task explicitly requires *"prefer lightweight CSS/SVG animation or a lightweight canvas implementation. Avoid heavy 3D libraries unless genuinely necessary."* → We rebuild the reactor as a **single 2D `<canvas>`** (rings, arcs, particles, glow via additive compositing) — visually equivalent, no new dependency, <10 KB.

## 4. Port matrix — reuse / adapt / replace

| JARVIS-v3 element | Disposition in Studio |
|---|---|
| Reactor (WebGL) | **Adapt** → 2D canvas `JarvisReactor` component, same state colors, same lerp model |
| State machine (`body[data-state]`) | **Adopt** → `data-jarvis-state` on app root; CSS var swap drives whole theme |
| Boot screen + INITIALIZE | **Adopt** → session-only boot overlay running *real* health/system/provider checks |
| Top HUD bar / clock / status pill | **Adopt** into Studio header (keeps provider dropdown, python badge, bell) |
| Stats rail (fake ARC POWER/NEURAL LINK meters) | **Adapt honestly** → meters bound to real data: provider uplink status, DB/task counts, uptime from `/api/health` |
| Console log + input | **Adopt** → JARVIS home transcript reuses existing `messages` state + `/api/jarvis` router + `/api/chat` stream |
| Mic button / wake word / TTS | **Reuse existing hooks** (`useVoiceInput`, `useSpeechOutput`, `useWakeWord`) — already production-tested in Studio |
| Gemini Live (WS, client key) | **Replace with supported equivalent**: LIVE toggle = continuous listen→send→speak loop through existing provider-agnostic backend. Native Gemini Live WS needs a raw client-side key + bypasses model router → not integrated; UI shows honest availability note |
| Skills (currency/weather/etc. in-page) | **Not ported** — Studio's chat/agent engine already covers tasks server-side; duplicating client-side skills would fake capability |
| Settings modal | **Adapt** → JARVIS settings (AI Brain / Voice / Listening / Routing) reusing existing endpoints |
| Tauri wrapper | **Skip** (web app) |

## 5. Re-skin strategy (why panels won't be rewritten)

All 25 panels hardcode Tailwind palette literals (`bg-zinc-950`, `text-emerald-400`, …). Tailwind v4 compiles every utility to `var(--color-zinc-950)` etc. → **overriding those CSS variables under a `.jarvis-scope` class on `<html>` re-skins the entire app with zero panel edits and zero logic risk** (shadcn semantic tokens overridden the same way; Radix portals inherit because the scope is on `<html>`).

## 6. Risks / constraints found

1. `GET /api/agentic/tasks/{id}/stream` (SSE) has **no auth check** — pre-existing; we do not widen it (we reuse it as-is, same as agentic panel).
2. Chat stream is raw text (not SSE) — must keep the existing reader loop; JARVIS home reuses `sendMessage` rather than re-implementing.
3. Server-side STT does not exist → mic transcription stays browser-side (Web Speech). Mic requires HTTPS/localhost — sandbox preview runs over HTTPS via gateway.
4. Wake-word bridge needs python deps; absent → hook surfaces an error, UI must show unavailable state (already does).
5. Windows-first project (`scripts/dev.mjs`, `start-studio.bat`) — final report must give exact Windows commands.
6. Tailwind v4 color overrides must respect alpha modifiers (`/60` compiles to `color-mix(in oklab, var(--color-zinc-900) 60%, transparent)`) — hex overrides are compatible.

## 7. Non-negotiables carried into Phase 2

- No rebuild: modify `studio.tsx` render shell, add `src/components/jarvis/*`, restyle via CSS scope.
- No mock data: every meter/panel on JARVIS home binds to the real endpoints listed in §2; unsupported capability → explicit unavailable state.
- Approval gates, kill switch, audit, secret masking stay engine-enforced; JARVIS home only *calls* existing approval APIs with the exact same payloads the existing panels send.
- No new runtime dependencies.
