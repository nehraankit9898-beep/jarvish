# Manual verification checklist

Run these after `npm run dev` (or the production build). Tick a box only when you **heard** the sentence or
**saw** the stated UI state — the point of this release is that JARVIS never silently does nothing.

Preparation

- [ ] `studio/.env` exists (`npm run setup` created it) with a non-empty `AGENTSCOPE_SECRET_KEY`.
- [ ] `npx prisma generate && npx prisma db push` completed.
- [ ] Settings → Voice shows a working **Test voice** (browser voice is enough).
- [ ] At least one provider is configured (see `PROVIDER_SETUP.md`).

---

## A. Voice

- [ ] **Test voice** in Settings → Voice plays audio. If it cannot, a red banner with the real reason appears.
- [ ] Toggle "Speak replies" off → **Test voice** still speaks; the panel says spoken replies are off.
- [ ] Reload the page → the toggle kept its value (localStorage `agentscope-tts-enabled`).
- [ ] Send a normal chat message → the reply is spoken; the "speaking…" indicator appears while audio plays.
- [ ] Send a second message while the first is speaking → the first stops; voices never overlap.
- [ ] The transcript line "Last spoken: …" matches the sentence you heard (no markdown/URLs read aloud).

## B. Offline mode (no cloud key needed)

- [ ] Say/type **"YouTube kholo"** → approval prompt (default `ask` mode) → after approval the browser opens
      YouTube and JARVIS says *"Haan, main aapki command samajh gaya. YouTube successfully open ho gaya."*
- [ ] **"notepad kholo"** (Windows) → same flow for the allowlisted app.
- [ ] **"status batao"** → speaks which providers are configured/verified and which voice engine is active.
- [ ] **"pichhli error batao"** after a failed action → repeats the real, sanitized error.
- [ ] **"cancel karo"** while a task runs → the task stops and the cancellation is spoken.
- [ ] **"https://example.com kholo"** (arbitrary URL) → refused; only allowlisted sites open.
- [ ] Disconnect the network → a normal command still gets an acknowledgement and an explicit failure; it does
      not hang or stay silent.

## C. Model selection

- [ ] Settings → Providers → Gemini → **Refresh models** → list is labelled **Live** with a timestamp.
- [ ] Disconnect the network and refresh → the list is labelled **Cached**/*Built-in catalog (not live)*, never
      presented as live.
- [ ] Pick a model, Save, reload the app → the same provider and model are active.
- [ ] Change the model after a passing test → the badge changes from **Connected** to
      **Configured — not verified** until you test again.
- [ ] Stored `gemini-2.0-flash` → on load you hear/see the migration to `gemini-3.8-flash`.
- [ ] Type a bogus model id and test → **Model unavailable**; no automatic switch and no fake success.

## D. Provider failures

- [ ] Wrong Gemini key → **Authentication failed**, message shown, key not echoed anywhere.
- [ ] Wrong OpenRouter key → same.
- [ ] Free OpenRouter model that is rate-limited → **Rate limited** with the retry window.
- [ ] Unplug the network and test → **Network unavailable** (not "invalid key").
- [ ] Point the base URL at a host that accepts the connection but never answers → **Timed out**.
- [ ] Each of the failures above is also **spoken** ("Gemini API connect nahi ho pa rahi. Error: …").

## E. PC actions and approvals

- [ ] A task requiring approval shows the approval card; no action runs before you press Approve.
- [ ] Denying it reports "cancelled" (spoken) and nothing is executed.
- [ ] No shell command typed into chat is executed verbatim; only allowlisted tools run.
- [ ] The audit log shows the same status the UI showed (one entry, correct category).

## F. Secrets

- [ ] `/api/providers` response contains `hasKey`/`keyHint` and **no** key material.
- [ ] The browser's localStorage contains `keyHint` but not the raw key (after saving via the new dialog).
- [ ] Server logs and audit entries show `••••` (or the last 4 chars), never the full key.
- [ ] Clearing the key field and pressing Save keeps the existing stored key working.

## G. Regression basics

- [ ] Existing conversations still load and new ones are created.
- [ ] Agentic panel still lists tasks and their statuses.
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` pass.
- [ ] `npm run test` passes except for tests that need a real database, if your machine cannot generate the Prisma
      client (see `TEST_RESULTS.md`).
