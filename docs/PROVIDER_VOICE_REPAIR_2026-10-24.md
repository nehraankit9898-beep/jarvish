# Provider, chat, voice and reactor repair — 2026-10-24

## Scope and evidence

This pass compared the supplied audit with the actual checkout. It is **not** a claim that every provider/model, microphone or desktop action has been tested live.

Several reported defects were already fixed on this branch before this pass: both provider UIs sent unsaved keys by POST, Settings fetched live models, Gemini authentication used `x-goog-api-key`, model-list fallback notes were visible, and Gemini safety/empty responses already had some handling. Changes below address remaining defects rather than duplicating those fixes.

### Model names are not verification

The supplied Gemini/Claude model IDs could not be independently checked against current official documentation in this network-restricted environment. No speculative Gemini/Claude IDs or retirement mappings were added. Existing static catalogs are still offline suggestions, not proof of model existence or account access. Live discovery preserves exact provider IDs, including IDs absent from the catalog; the manual model-ID input now works for every provider.

Discovery and a successful inference test remain separate. This pass deliberately does **not** run paid inference against every discovered model, automatically change the user's selected provider/model, or promise that every listed model supports every feature.

## Changes

### Model discovery

- Debounced automatic discovery after provider, key or endpoint edits in Settings and Providers.
- Aborts superseded discovery requests and ignores stale responses; credentials stay in POST bodies, not URLs.
- Gemini pagination: `pageSize=1000` and opaque `nextPageToken` traversal.
- Anthropic pagination: `limit=1000` and `after_id` traversal while `has_more` is true.
- One timeout across pages, repeated/missing-cursor guards and a 100-page bound. Cursor values never become arbitrary credential-bearing URLs. A later-page failure is not returned as a successful partial list.
- Ollama uses native `/api/tags` to list installed models without a key. Its fallback no longer fabricates an installed-model list from the static catalog; Settings also stops using that catalog as an installed-model picker.
- Expanded generic non-chat filtering for transcription, realtime/audio and video families. This remains a capability/name heuristic, not an exhaustive compatibility guarantee.
- Chat-only versus all-model discovery have separate cache identities. Cache keys use SHA-256 instead of a short collision-prone hash; cache growth is bounded.
- Preserves the discovery layer's filtered-out count in the API response.

### Chat execution

- Shared Chat Completions parameter builder used by probes and actual chat: o1/o3/o4/GPT-5 families omit temperature and use `max_completion_tokens` when a budget is supplied. Probe budget is 1024 so reasoning tokens are less likely to consume the entire response allowance. Other models retain normal temperature/`max_tokens` options.
- Removes orphan assistant prefixes from truncated history at the shared provider boundary, retaining system messages.
- `/api/chat` rejects an explicit model without an explicit provider instead of pairing it with the implicit Z.ai default.
- Shared SSE parsing now surfaces OpenAI/Anthropic/Gemini error events, empty streams, OpenAI content filtering and Gemini safety/abnormal finishes, including failures after partial output. Gemini thought parts are not shown as assistant text.
- Fixed a pending-read stall when upstream TCP chunks contain only part of an SSE line. Tests also cover byte-by-byte UTF-8, CRLF-compatible parsing and final frames without a trailing newline.
- Chat-to-browser transport is now `application/x-ndjson` with `X-Chat-Stream: ndjson-v1`: separate `text`, `error` and `done` events. The browser yields only text to incremental TTS; sanitized error details reach the existing UI failure handler. Missing completion frames are failures, not silent successful truncations. The browser parser retains compatibility with old plain-text servers.
- Stop/cancellation releases the upstream reader rather than trying to cancel a locked stream.
- Removed artificial character-by-character replay delays from the non-streaming Z.ai SDK path. **That SDK path still buffers a whole completion**; this change does not make it true upstream streaming. The HTTP API-key path already uses upstream SSE.

**Integration note:** external consumers of `/api/chat` must parse the new framed protocol instead of treating its raw response body as assistant text.

### Credential persistence

- New connection data is serialized without raw API keys or legacy `raw:<key>` test signatures. Unsaved keys are tab-memory-only.
- Legacy plaintext keys/signatures are scrubbed from localStorage on load. The current tab retains the key and attempts migration to encrypted server storage.
- Failed migration leaves a visible session-only warning. **If encrypted saving fails, save successfully in Settings before closing/reloading the tab; the session-only key will not survive.** Other already-open tabs can retain their own in-memory state until refreshed.
- Random session identities distinguish unsaved keys for verification without embedding secrets in persisted test signatures.
- Settings no longer falls back to a plaintext browser save on server/encryption failure, nor activates a provider after a failed save. A successful test can explicitly retain its verified result through encrypted saving; saving clears the draft key. Superseded test responses do not mark a newly edited draft as verified.

### Voice and reactor

- New default recognition language: `en-IN`; existing saved Hindi/English preferences and the language switch remain supported. This is browser speech recognition, not local Whisper or Gemini native audio.
- Default voice bridge voice: `en-IN-NeerjaNeural`; `AGENTSCOPE_TTS_VOICE` overrides and explicit Hindi choices remain available.
- Browser voice selection prefers Indian English, then Hindi/other English. It no longer selects an arbitrary unrelated language voice; absence of a compatible voice is a fallback failure, not random-language playback.
- Legacy `[Stream error: ...]` diagnostics are stripped by the speech text sanitizer as defense in depth; new chat diagnostics never enter the speech queue.
- Reactor never opens a second microphone. It accepts an optional shared `audioLevel`; without one its pulse is decorative, not measured mic activity.
- Reactor reduced-motion frames redraw on state changes and resize, set the target color immediately, and react to preference changes.
- Reactor capped at 30 FPS, DPR 1.25 and 60 particles instead of 150. Actual i3/Windows performance still needs measurement.
- Reactor remains a lightweight **2D canvas visualization**. No WebGL character, character asset, facial expressions or lip-sync engine was added.

## Verification

| Check | Result |
|---|---|
| TypeScript (`npm run typecheck`) | Pass |
| Targeted tests, 7 files | 102 pass, 0 fail |
| Additional provider-route/status/model/voice/performance tests, 5 files | 61 pass, 0 fail |
| Total tested | **163 pass, 0 fail**; includes 31 new regression tests |
| ESLint (`npm run lint`) | Pass, 0 errors; 46 warnings remain |
| Production build (`npm run build`) | Pass, including standalone copy; dynamic-filesystem tracing warnings remain |
| Python bridge syntax compilation | Pass |
| `git diff --check` | Pass |
| Full database-backed suite | Not completed; runtime Prisma engine download unavailable |
| Real cloud API round trips / account access / quota | Not run |
| Installed Ollama inference on the user's PC | Not run |
| Browser mic/speaker playback / Windows audio contention | Not run |
| Browser visual/reduced-motion integration and i3 benchmark | Not run |

### Prisma environment caveat

Normal `prisma generate` failed downloading the native engine from `binaries.prisma.sh` (network/TLS restriction). For type generation and build validation only, this workspace used:

```sh
PRISMA_SCHEMA_ENGINE_BINARY=/bin/true PRISMA_QUERY_ENGINE_LIBRARY=/bin/true npx prisma generate --no-engine
```

This is **not** a runtime database configuration and no such environment setting was committed. The build/typecheck results do not prove SQLite runtime readiness. On a normal installation, run regular `npm run db:generate` and initialize the database following the project's setup instructions before starting the app or running database-backed tests. The initial attempted database regression run failed during Prisma initialization, not a provider assertion.

## Remaining work

1. Use real accounts to verify discovery, selected-model inference, quota/permissions, stop behavior and account-specific availability. No credentials should be pasted into chat.
2. Test encrypted persistence/restart and legacy migration end to end against a working database, including server-save failures and tab closure.
3. Exercise UI key-edit races, mic/TTS interruption, autoplay restrictions and voice bridge availability in Chrome/Edge on the target Windows machine.
4. Keep model catalogs/retirement rules grounded in provider evidence; model discovery is not a universal capability validator. Provider-specific parameter differences beyond the covered families may still require adapters.
5. Define and test universal exactly-once desktop-action confirmations separately. Existing action lifecycle, permission enforcement and orchestration fallback behavior were not comprehensively re-audited here.
6. If desired, specify a separate real-3D avatar feature (WebGL runtime, assets/licensing, lip-sync, expressions, and low-end performance budget) rather than calling the current canvas reactor 3D.

## Reproduce targeted tests

From `studio/`, after dependencies are installed:

```sh
bun test tests/provider-voice-audit.test.ts tests/provider-connection.test.ts \
  tests/voice-regressions.test.ts tests/voice-stream.test.ts \
  tests/model-migration-notice.test.ts tests/chat-stream.test.ts \
  tests/browser-key-storage.test.ts

bun test tests/provider-routes.test.ts tests/provider-status-regressions.test.ts \
  tests/gemini-model.test.ts tests/voice-feedback.test.ts tests/perf-optimization.test.ts

npm run typecheck
npm run lint
npm run build
```

The two test invocations are intentionally separate: route-contract tests mock provider modules, whereas provider-connection tests exercise their real implementations with mocked network responses.
