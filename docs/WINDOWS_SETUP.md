# Windows — setup & launch guide

This guide matches the scripts that actually exist in this repository. Nothing here needs a Linux
environment; the app is a normal Next.js server plus a SQLite file.

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Windows | 10 or 11 (x64) | — |
| Node.js | **20 LTS or newer** (22 tested) | Next.js 16 runtime |
| npm | ships with Node | installs dependencies |
| bun (optional) | 1.x | the project's test runner; `npm run test` calls `bun test` |
| Python | 3.10+ (optional) | natural voice (edge-TTS) + wake word + desktop bridge |

> **No Python is required for basic use.** The browser's own speech synthesis is the fallback voice.

---

## 2. One-time install

```bat
cd <path-to-repo>\studio
npm install
```

Copy the example environment file and create a secret:

```bat
copy .env.example .env
node scripts\setup.mjs
```

`scripts\setup.mjs` keeps an existing `.env`, generates `AGENTSCOPE_SECRET_KEY` when it is empty, then runs
`prisma generate` and `prisma db push`. If you prefer to do it by hand:

```bat
npx prisma generate
npx prisma db push
```

**If `prisma generate` fails** with `request to https://binaries.prisma.sh/... failed`, a proxy/firewall is
blocking Prisma's engine download. Allow `binaries.prisma.sh` (or set `HTTPS_PROXY`) and re-run it. The
project cannot start without the generated client.

PowerShell alternative (does all of the above, plus the test suite):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1 -SkipTests
```

---

## 3. Start

Development (hot reload):

```bat
npm run dev
```

or the one-click launcher from the repository root:

```bat
start-studio.bat
```

Open <http://localhost:3000>.

Production:

```bat
npm run build
npm run start
```

(or `powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1`, then `start-prod.ps1`.)

Optional: register the Studio + tray icon to start at logon:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-studio.ps1
```

The scheduled task expects that `npm run build` has been run at least once.

---

## 4. Add an AI provider

1. Open the app → **Settings** (or the JARVIS gear → **AI Brain**).
2. Pick **Gemini** or **OpenRouter**, paste the key, keep the prefilled model, click **Test connection**.
3. Only a *passing* test shows **Connected**. Saving alone shows **Configured — not verified**.
4. Exact steps and expected strings: [`PROVIDER_SETUP.md`](./PROVIDER_SETUP.md).

Keys are encrypted server-side (AES-256-GCM, `AGENTSCOPE_SECRET_KEY`) and are never returned by the API —
the browser only receives `hasKey` and the last 4 characters (`keyHint`).

---

## 5. Voice

Browser-only (zero install): speech recognition + `speechSynthesis` work in Edge/Chrome. Spoken replies are
**on by default**; the toggle is in JARVIS settings → Voice, and **Test voice** works even while muted.

Natural voice (Python bridge, optional):

```bat
cd studio
pip install -r python-bridge\requirements-voice.txt
```

Then start the app — the bridge listens on `127.0.0.1:8792` and is launched automatically. Check it in
Settings → Voice ("Voice bridge: ● online"). It needs internet access for Microsoft edge-TTS; with no
network JARVIS falls back to the browser voice and says so if neither works.

---

## 6. Permissions and PC actions

* Default mode is `AGENTSCOPE_HOST_MODE=ask`: reads run, every write/launch needs approval.
* Approve/deny from the JARVIS panel (`/api/host` → `approve` / `deny`). The task waits for the decision.
* `AGENTSCOPE_DESKTOP_MODE=locked` by default — screen/mouse/keyboard control must be enabled explicitly.
* Do not set `trusted` or `AGENTSCOPE_ALLOW_UNAUTHENTICATED=1` on a shared machine.
* Destructive actions always require approval; there is no "skip approval" switch.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 3000 is in use` | stop the other process or run `start-dev.ps1 -Port 3001` |
| `Prisma Client could not locate the Query Engine` | run `npx prisma generate` again (allow `binaries.prisma.sh`) |
| `database is locked` | close other Studio instances; the SQLite file is `studio/db/custom.db` |
| Test says **Authentication failed** | the key is wrong/revoked — create a new one |
| Test says **Model unavailable** | use the model picker → **Refresh** to load the provider's live list |
| Test says **Rate limited** | free tiers are per-minute/per-day; wait for the retry window shown |
| Ollama/LM Studio unreachable | keep `AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK=1`, make sure the local server is running |
| No sound | Settings → Voice → **Test voice**; check the red banner; Windows volume mixer → browser |
| Speech works but is cut off | another tab is speaking; JARVIS stops the previous utterance by design |

Health check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1
```

---

## 8. Verifying the install

```bat
cd studio
npm run typecheck
npm run lint
npm run test        :: needs bun (npm i -g bun)
npm run build
```

Expected on a machine with a working `prisma generate` and SQLite: all four succeed.
See [`TEST_RESULTS.md`](./TEST_RESULTS.md) for the results obtained in the build sandbox and the one
environment blocker (Prisma engine download) that could not be reproduced there.
