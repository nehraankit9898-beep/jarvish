# JARVIS Performance Optimization — Report

**Goal:** faster API replies, sooner speech, no UI freezing, efficient on an
i3 / 8–12 GB / integrated-graphics Windows PC. **No new features, no visual
redesign, no new dependencies** (`package.json` untouched).

All work was done in small phases on `arena/4bc73a25-jarvish`. Every number
below was actually measured — sandbox limits are stated honestly in §7.

---

## 1. What changed (per phase)

### Phase 1 — Audit + baseline (no behavior changes)

Inspected: `use-speech.ts`, `chat/route.ts`, `jarvis/route.ts`,
`voice/speak/route.ts`, `model-router.ts`, `provider-store.ts`,
`provider-connection.ts`, `voice-bridge.ts`, `jarvis-dashboard.tsx`,
`jarvis-reactor.tsx`, `studio.tsx` + callers/tests/bridges.

**Baseline:** 204/204 runnable unit tests pass · `tsc` 26 pre-existing errors
(all from the missing Prisma generated client — the sandbox cannot reach
`binaries.prisma.sh`, so `prisma generate`/`db push` cannot run here) ·
13 test files + full-server runs need a real machine (see §5).

### Phase 2 — API streaming + request lifecycle

| File | Change |
|---|---|
| `src/lib/llm-core.ts` | `LLMConfig.signal` (caller abort) combined with the timeout via `AbortSignal.any`; stream `cancel()` now also aborts the upstream fetch (socket released immediately); new pure `parseApiError()` (status + Retry-After) and `capHistoryContext()` (count + char caps, newest message always survives) |
| `src/app/api/chat/route.ts` | History capped (40 msgs **and** 24k chars); `req.signal` forwarded upstream (Stop now stops the provider call); `cancel()` on the output stream; provider 429 keeps status + `Retry-After` instead of flat 502; `Server-Timing: setup, upstream` header |
| `src/components/studio/studio.tsx` | Stream paints batched to ~20/sec (was: every chunk → setState + full markdown re-parse); 429 shows "Rate limit … Ns me dobara try karo"; perf marks (`chat.intent`, `chat.ttft`, `chat.total`) |
| `src/lib/perf.ts` *(new)* | Bounded (300-sample) timing collector + median/P95 — client & server safe, ~0.001 ms per sample |
| `tests/perf-optimization.test.ts` *(new)* | 14 tests: 429 round-trip, history caps, perf buffer/stats/bounds |

Deliberate non-changes: interactive chat stays **single-target, fail-fast**
(no auto provider-switch mid-conversation — bounded retries live in the
agentic `ModelRouter`, which was verified, not duplicated). Keep-alive
pooling verified on the runtime (10 gapped requests → 1 TCP connection;
a tight loop opens a 2nd only under saturation) — no custom agent needed.

### Phase 3 — Incremental TTS + voice control

| File | Change |
|---|---|
| `src/hooks/use-speech.ts` | `splitStreamSentences()` (`. ! ? … ।`, quotes, `3.5`-safe, newline + 280-char hard caps); `createSentenceChain()` — ordered, strictly sequential playback, **prefetch-1** (synth(n+1) overlaps play(n)), queue bound 6 (overflow merges into tail), identical-sentence audio reuse (never 2 simultaneous synths of one sentence), per-sentence browser fallback, hang guard (30 s cap + cancel), stale-session guards; `useSpeechOutput().startStreamSpeak()` wiring + `tts.firstAudio` mark |
| `studio.tsx` | Stream chunks feed the voice session (`feed`/`done`/`abort`); TTS-off-at-start still falls back to `speak(full)` (mid-stream enable preserved); failed/aborted replies stop speech |
| `voice-bridge.ts`, `voice/speak/route.ts` | `voiceCall` accepts `signal`; speak route passes `req.signal` (interrupted speech ends the 45 s bridge wait immediately) |
| `tests/voice-stream.test.ts` *(new)* | 22 tests incl. "playback STARTS before done()", order, dedup, bounds, abort-once, stale-guard, prefetch-overlap timing |

Known limitation (documented, not hidden): **sentence-level**, not
word-level streaming — the bridge returns one complete MP3 per request and
edge-tts needs network access (it is NOT offline). Hindi (`hi-IN`) and
English (`en-IN`) voices unchanged; wake echo-guard, LIVE guards untouched.

### Phase 4 — Polling, events, animation

| File | Change |
|---|---|
| `src/hooks/use-polling.ts` *(new)* + `tests/poller.test.ts` *(new, 6 tests)* | `Poller`: skips ticks while hidden, one fresh refresh on return, never overlaps in-flight runs, aborts on unmount; `usePolling()` wrapper |
| `jarvis-dashboard.tsx` | 4 pollers → `usePolling` (same cadences: 60/30/5/30 s) + fetch abort signals; transcript rows memoized (`TranscriptLine` — one markdown parse per flush instead of per message per chunk); autoscroll only near bottom + `auto` (not `smooth`) while streaming |
| `studio.tsx` | **HUD clock extracted to `StudioClock`** (was: whole-tree re-render every second — now only the span); tasks/notifications → `usePolling`; chat scroll `auto` while streaming |
| `laptop-panel.tsx`, `notifications-bell.tsx` | 3 s / 30 s polls → `usePolling` |
| `use-speech.ts` (wake) | pause/resume POST only on change (+ re-assert on bridge mismatch); hidden tabs skip `setStatus` — **but the 2 s poll itself keeps running**: hands-free is an explicit always-listening feature and must hear "Hey Jarvis" while minimized |
| `jarvis-reactor.tsx` | Constant stroke styles hoisted out of per-tick loops (behavior-identical; ~150 fewer style allocs/frame). DPR cap, visibility pause, reduced-motion preserved |

SSE task stream, resume/reconnect, approval payloads, kill switch, audit —
untouched.

### Phase 5 — Regression, benchmarks, report (this file)

---

## 2. Test results

Sandbox runner: `bun`'s CDN is blocked here, so tests run via a
`bun:test`→`node:test` shim kept in `/tmp` (NOT in the repo). 13 DB-backed
files cannot run in the sandbox (no Prisma engines — see §7) and must run
on a real machine/CI.

| Suite | Result |
|---|---|
| Baseline (12 files) | **204/204 pass** |
| + `perf-optimization` (14) + `voice-stream` (22) + `poller` (6) + `perf-benchmarks` (7) | **253/253 pass** |
| `tsc --noEmit` | identical to baseline (26 pre-existing Prisma-stub errors, **0 new**) |
| `eslint` (changed + new files) | 10 errors + 1 warning, all pre-existing (baseline: 11 + 2 on fewer files — **0 new**, new files clean) |

## 3. Measured benchmarks (sandbox CPU — methodology in `tests/perf-benchmarks.test.ts`)

Re-run anywhere with `bun test tests/perf-benchmarks.test.ts` and compare on
the SAME box (these are measurements, not cross-machine promises):

| Function | median | p95 |
|---|---|---|
| `jarvis.detectIntent` (local routing, no LLM) | 0.001 ms | 0.001 ms |
| `router.classifyRouterError` | 0.003 ms | 0.006 ms |
| `chat.parseApiError` | 0.001 ms | 0.001 ms |
| `chat.capHistoryContext` (40 msgs) | 0.004 ms | 0.005 ms |
| `tts.speechFriendly` (1200 chars) | 0.030 ms | 0.045 ms |
| `tts.splitStreamSentences` | 0.006 ms | 0.010 ms |
| `perf.record` ×1000 | 0.89 ms total (~0.001 ms each) | — |
| Voice chain pipeline (3× 40 ms synth + 10 ms play, mocked) | total < 140 ms asserted (naive sequential ≥ 150 ms) | first audio < 80 ms |

Local routing costs ~1 µs — Rule 4's "no LLM for deterministic commands"
costs nothing measurable. TTS incremental start is proven by test
("playback STARTS before done()") rather than by wall-clock claims.

## 4. Manual verification matrix (needs a Windows PC + provider key)

Setup once: run the project (§6), open DevTools → Network, enable TTS
(speaker button). Timings: `chat.ttft`/`chat.total`/`tts.firstAudio` are in
the in-memory perf buffer; `Server-Timing` response header shows
`setup`/`upstream` ms per `/api/chat` call.

| # | Scenario | Steps | Expect |
|---|---|---|---|
| 1 | Simple local command | Type "calculator khol do" (host mode `ask`) | Instant intent (<5 ms), task starts, approval card appears; works with provider offline |
| 2 | Short API conversation | "Namaste, kya haal hai?" | Text streams progressively; TTFT ≈ provider TTFT + ~50 ms paint batch |
| 3 | Long streamed response | "Hindi me 500 shabd ki kahani likho" | UI stays responsive while streaming (≤20 paints/s); scroll follows only at bottom |
| 4 | Stream + voice | Same as 3 with TTS on | First sentence speaks ~1–3 s in (one synth), NOT after the full story; order preserved; no overlap |
| 5 | Slow API | Throttle network (DevTools → Slow 3G) | Chunks still forward progressively; Stop aborts cleanly; no freeze |
| 6 | Timeout / network failure | Invalid baseUrl, or offline | Clear error toast, failed reply not persisted as AI message, UI responsive |
| 7 | Rate limit | (Or mock 429) | "Rate limit … Ns me dobara try karo" (not generic 502); `Retry-After` header present |
| 8 | Interruption | TTS on → long reply → STOP mid-speech | Speech + stream stop <300 ms; no residual audio; LIVE mic does not self-trigger |
| 9 | Rapid commands | Send 5 messages quickly | Ref-guard serializes; no duplicate sends; sessions don't overlap speech |
| 10 | Long task + dashboard | Start agentic task, watch JARVIS home | SSE LIVE, approvals arrive, reactor animates, no jank; hidden tab pauses polls (except wake) |
| 11 | Memory growth | 10 long chats in a row | Perf buffer ≤300, TTS cache ≤8, queue ≤6; heap stable (DevTools Memory) |
| 12 | Shutdown/restart | Close Studio mid-TTS/task → reopen | No orphaned audio; timers/listeners cleaned (no console warnings); bridge respawns on demand |

## 5. Exact Windows commands

```powershell
# 1) setup (first time)
cd path\to\agentscope-suite\studio
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1

# 2) typecheck + FULL test suite (incl. the 13 DB-backed files)
npx tsc --noEmit
bun test                                   # or: bun test tests/voice-stream.test.ts (one file)

# 3) benchmarks (numbers, same box before/after)
bun test tests/perf-benchmarks.test.ts

# 4) run (dev)
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1
# open http://localhost:3000  → JARVIS mode is the landing screen

# 5) voice bridge (natural voice; needs internet for edge-tts)
pip install -r python-bridge/requirements-voice.txt
```

## 6. Files changed (final)

```
M  src/lib/llm-core.ts                  M  src/components/studio/studio.tsx
M  src/app/api/chat/route.ts            M  src/hooks/use-speech.ts
M  src/app/api/voice/speak/route.ts     M  src/lib/agentic/voice-bridge.ts
M  src/components/jarvis/jarvis-dashboard.tsx
M  src/components/jarvis/jarvis-reactor.tsx
M  src/components/studio/laptop-panel.tsx
M  src/components/studio/notifications-bell.tsx
A  src/lib/perf.ts  A  src/hooks/use-polling.ts
A  tests/perf-optimization.test.ts  A  tests/voice-stream.test.ts
A  tests/poller.test.ts  A  tests/perf-benchmarks.test.ts
A  docs/PERF_OPTIMIZATION.md (this file)
```

## 7. Remaining limitations (honest list)

1. **Sandbox could not run Prisma** (`binaries.prisma.sh` blocked): the 13
   DB-backed test files, `prisma generate`/`db push`, and full-server runs
   are unverified here — run §5 on a real machine. `tsc` still reports the
   26 pre-existing stub-client errors there until `prisma generate` runs
   (they vanish with a real generated client, as before this change).
2. **No wall-clock before/after for API/TTS** — no provider key and no
   Microsoft-voices network in the sandbox. Speedups are structural
   (incremental start, fewer paints/renders/requests) + mock-timed tests,
   not fabricated millisecond claims. Use matrix §4 for real numbers.
3. **TTS is sentence-level**, not word-level (bridge returns whole-MP3 per
   request; edge-tts needs internet). Abbreviations ("Mr. Smith") may split
   across two spoken chunks — order and words stay correct.
4. **Orchestrator mid-LLM-call cancel** still relies on the per-call timeout
   (default 120 s, role-configurable); cancellation is checked between
   steps/batches. Wiring abort through the whole run loop was judged too
   invasive for this pass. Interactive chat cancel IS fully wired.
5. **Chat uses the browser-local key only** (pre-existing: server-side stored
   keys are used by the agentic engine, not `/api/chat`) — out of scope,
   unchanged.
6. `dev.log` grows unbounded in dev (pre-existing) — noted, not changed.
