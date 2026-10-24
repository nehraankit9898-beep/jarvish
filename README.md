# AgentScope Suite — AgentScope Python + Studio UI (ek hi package)

Ye package **do cheezein ek saath** hai:

```
agentscope-suite/
├── agentscope/    ← Alibaba ka AgentScope Python framework v2.0.10 (pip-installable — pyproject.toml included)
├── studio/        ← AgentScope Studio (Next.js web UI + Agentic AI Engine)
├── start-studio.sh   ← Mac/Linux start script
└── start-studio.bat  ← Windows start script
```

## Dono ka connection kya hai?

- **agentscope/** = Python framework ka **pip-installable source** (real `Agent`, `Msg`, `OpenAIChatModel`, `GeminiChatModel` classes). `pyproject.toml` included — `pip install -e ./agentscope` seedha chalta hai (dependencies auto-install hongi).
- **studio/** = Web UI jo bina Python ke bhi independently chalti hai. Jab aapke PC pe AgentScope Python installed hoga, Studio **usse real me connect** ho jata hai (Python bridge se) — header me `🐍 AgentScope: vX.Y.Z` badge green ho jayega.

## Setup (5 minute)

### 1) Studio chalao (Python ki zaroorat NAHI)

**Windows (recommended):**

```powershell
cd agentscope-suite\studio
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1
```

Poori guide: [`studio/docs/WINDOWS_SETUP.md`](studio/docs/WINDOWS_SETUP.md)

**Any OS:**

```bash
cd agentscope-suite/studio
npm install          # ya: bun install
npm run setup       # private .env + Prisma client + SQLite schema (no reset)
npm run dev          # http://localhost:3000
```

Ya root se ek command: `./start-studio.sh` (Windows: `start-studio.bat`).

Health check (Windows):
`powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1`

### 2) API connection (easy)

Real AI responses ke liye **configured provider** zaroori hai. Z.ai built-in engine sirf compatible SDK credentials/configuration available hone par chalta hai; fresh install par free access guaranteed nahi hai.
Apni keys ke liye: **API Settings** → provider chuno (OpenAI / Claude / Gemini / DeepSeek / Qwen / Kimi / Grok / Ollama / Custom) → key paste → **Test Connection** → **Use this provider**.

> Browser ki localStorage wala flow abhi bhi kaam karta hai. Naya **server-side** flow bhi hai: **Providers** panel me key daalo — wo **encrypted** (AES-256-GCM) server par store hoti hai aur browser ko kabhi wapas nahi bheji jati (sirf `••••1234` hint). Usi panel se provider enable/disable, priority, cost class (free/paid), timeout/retry, per-agent model preference aur **free-only mode** set hota hai — free-only me paid model kabhi select nahi hota.

### 3) AgentScope Python install (optional — real integration)

> Ab `agentscope/` folder me `pyproject.toml` included hai — bundled source se seedha install karo (exact v2.0.10, offline bhi chalega):

```bash
pip install -e ./agentscope
python3 -c "import agentscope; print(agentscope.__version__)"
```

(Alternative: `pip install agentscope` PyPI se bhi chal jayega.)

Studio restart karo → header me **🐍 AgentScope: vX.Y.Z** badge aa jayega.
Ab Studio ke agents ko Python engine se real me chala sakte ho:

```bash
curl -X POST http://localhost:3000/api/agentscope/run \
  -H 'Content-Type: application/json' \
  -d '{"agentId": "<agent-id>", "prompt": "Hello!"}'
```

Bridge real AgentScope classes use karta hai: `agentscope.agent.Agent`, `Msg`, `TextBlock`, `OpenAICredential` / `GeminiCredential` / `AnthropicCredential` + matching ChatModels (dekho: `studio/python-bridge/runner.py`).

## Agentic AI Engine (Studio ke andar hi built)

Studio sidebar me **Agentic** tab dabao:

1. **High-level task likho** → **Plan banao**
2. 🧠 **Planner** step-by-step plan banata hai → tum **Approve & Run** dabao
3. Har step me ek role chalta hai: 🔬 **Researcher** (read-only investigation) → 👨‍💻 **Coder** (files likhta hai) → 🐛 **Debugger** (root-cause + minimal fix) → 🧪 **Tester** (real exit codes) → 🛡️ **Security Reviewer** (`SECURITY_REVIEW.md`) → 📚 **Documentation** (README/API docs) → 🔍 **Reviewer** (PASS/FAIL)
4. Fail par **bounded targeted fixes** (max 2 retry/step)
5. **Final Report**: changed files, commands, test results, remaining bugs

**Safety:**
- Har task ka **isolated workspace** (`.agentic-workspace/<taskId>/`) — path traversal blocked
- Commands classification: `safe` (auto) / `review` (workspace me auto) / **`destructive` (rm, git push... — UI approval ZAROORI)** / `forbidden` (rm -rf /, curl|sh — kabhi nahi)
- Approval sirf **engine ke maange gaye command** ke liye valid hai — API se arbitrary command approve karke gate bypass nahi kar sakte
- **Secrets masking** — keys/passwords outputs se redact
- **Audit trail** — har privileged action (actor, approval, result) `AuditLog` me likha jaata hai, UI me **Audit** tab
- **Git diff + rollback** har step ke snapshot ke saath
- Environment sanitized

## Laptop control, background worker, e-mail (added in the completion pass)

### 1) Laptop control — `Laptop` tab, `/api/host`, tools `host-*`
Until now the agent only worked inside `.agentic-workspace/<taskId>/`. There is now a separate, deliberate door to your **real** laptop:
run commands (PowerShell on Windows), read / write / list / delete files anywhere, open URLs and documents, send e-mail.

You hold the gate. Set `AGENTSCOPE_HOST_MODE` in `.env`:

| Mode | What the agent can do |
|---|---|
| `locked` | nothing |
| `ask` *(default)* | reads run by themselves; every write, command, delete, app launch and e-mail waits for **your** Approve in the *Laptop* tab |
| `trusted` | like `ask`, but new files / routine commands **inside `AGENTSCOPE_HOST_TRUSTED_DIRS`** skip the prompt |

In **every** mode: delete, overwrite, risky commands and e-mail always ask; `rm -rf /`, `curl | sh`, system folders, `.ssh`, `.aws`, `.env`, browser password/cookie stores and wallet files are **refused** (approval cannot unlock them). An approval runs the exact action the server stored (the caller cannot swap it), is single-use and expires in 10 minutes. Output is secret-masked, and the child process never inherits the Studio's own API keys.
The agent has no tool that can approve — only the *Laptop* tab / `POST /api/host {op:'approve'}` can.

### 2) Background worker in its own process
```powershell
bun run worker                                   # foreground
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker.ps1          # start at every logon, hidden, auto-restart
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-worker.ps1 -Remove
```
Cron schedules, crash recovery and proactive scans now keep running after you close the Studio window **or restart the Studio server**. A lock file with a heartbeat guarantees only one ticker runs (the server yields while the worker is alive and takes over if it dies). Set `AGENTSCOPE_BACKGROUND_RUNTIME=external` to make the worker the only ticker.
Honest limits: this is a per-user scheduled task, not a Windows Service — it does not run while you are logged out, and a sleeping or shut-down laptop runs nothing (missed schedules are recovered by their misfire policy at the next start). For true 24/7 work run the Studio on an always-on machine.

### 3) E-mail and meeting invites — tool `host-email`
Real SMTP (`AGENTSCOPE_SMTP_URL`, `AGENTSCOPE_SMTP_FROM` in `.env`; for Gmail use an app password). Always needs your approval. "Sent" means the mail server accepted **every** recipient with a 2xx reply — otherwise the result is an error. A `meeting` adds a standard calendar invite (.ics REQUEST) that Gmail/Outlook show with Accept/Decline.

### 4) Provider `Retry-After`
A 429 now carries the provider's `Retry-After`. Short waits are honoured and the same model is retried; long ones (> 60 s) park that model until its quota resets and the router moves to the next model — no retry storm.

### Not built (and why)
* **Stripe Link payments / purchase protection execution (spec features 14–15).** Stripe's agent wallet exists (`@stripe/link-cli`), but the documentation I found says the initial program is **US / USD**, and it needs your own Link account and approval flow, so I could not build or verify it. The existing payment *guard* stays: the browser engine detects checkouts and only **you** can confirm a payment. Purchase-protection *claim workflows* exist as the deterministic template in `workflows.ts`.
* **Orchestrator auto-use of the `host-*` tools.** They are in the tool registry (`/api/tools`, `/api/tools/invoke`) and fully gated, but the role prompts in `orchestrator.ts` were not changed to call them on their own. Today you drive them from the Laptop tab / API.

## Laptop-control pack — OpenClaw roadmap ke saare 10 features

Ye 10 features laptop-control roadmap (OpenClaw concepts) se banaye gaye hain. Sab kuch **pehle se maujood safety layer** (host-control modes, approvals, audit, secret masking) ke upar bana hai — koi duplicate permission system nahi, koi purana feature remove nahi.

| # | Feature | Kahan | Kaise on karein |
|---|---------|-------|-----------------|
| 1 | **Safety layer** — kill switch (UI button + global hotkey + Telegram `/kill` + mouse-corner fail-safe), permission modes, prompt-injection guard | `safety.ts`, Laptop tab | hamesha ON; hotkey `AGENTSCOPE_KILL_HOTKEY` (default `ctrl+shift+f12`) |
| 2 | **Allowed roots** — Desktop/Documents/Downloads me free kaam, delete → **Recycle Bin** (send2trash, kabhi permanent nahi) | `allowed-roots.ts`, tools `host-tree`, `host-trash` | default roots set hain; `AGENTSCOPE_ALLOWED_ROOTS` se badlo |
| 3 | **Downloads** — `download-file` tool (SSRF-guarded, 200 MB cap, collision-safe) + Downloads folder watcher (naye file par notification) | `downloads.ts` | watcher background runtime me auto-start; `AGENTSCOPE_DOWNLOADS_DIR` |
| 4 | **Browser history** — Chrome/Edge/Brave History SQLite ko temp-copy karke read-only search (sirf titles+URLs — cookies/logins kabhi nahi) | `browser-history.ts`, tool `browser-history-search`, Laptop tab search | desktop bridge zaroori (python stdlib sqlite3) |
| 5 | **Asli Chrome** — running Chrome se `connectOverCDP` (aapke real logins ke saath) | browser-service `connectRealChrome`, tool `browser-cdp-connect`, Laptop tab | Chrome kholo: `chrome.exe --remote-debugging-port=9222` |
| 6 | **Voice** — mic button (Web Speech API, Hindi `hi-IN` + English `en-IN` toggle) + jawab bolne wala TTS | Chat input me 🎙 + 🔊 buttons | Chrome/Edge me automatic; koi heavy model nahi |
| 7 | **Mouse + keyboard + screen** — pyautogui+mss bridge: screenshot, click, type, hotkey, scroll, move | `desktop-bridge.ts` + `python-bridge/desktop_bridge.py`, tools `desktop-*` | `.env` me `AGENTSCOPE_DESKTOP_MODE=ask` + `pip install -r python-bridge/requirements-desktop.txt` |
| 8 | **App/window control** — open_app, list_windows, focus_window, clipboard get/set, volume, lock_screen | same desktop tools | same |
| 9 | **Phone se control** — Telegram bot (sirf aapki allow-listed ID), commands `/status /pending /approve /deny /kill /resume`, plain text → naya task | `telegram-connector.ts` | `.env` me `AGENTSCOPE_TELEGRAM_BOT_TOKEN` + `AGENTSCOPE_TELEGRAM_ALLOWED_IDS` |
| 10 | **Automation recipes** — 5 ready-made schedules (Downloads cleanup 9 baje, daily summary, downloads digest, weekly audit review, browsing digest) | Automation tab → Recipes | Apply dabao → enable karo |

### Desktop bridge setup (features 4/7/8 ke liye — optional)

```powershell
cd studio
pip install -r python-bridge/requirements-desktop.txt
# .env me:
AGENTSCOPE_DESKTOP_MODE=ask        # har desktop action par approval (recommended)
```

Bridge sirf **127.0.0.1** pe bind hota hai, token (`db/.desktop-token`) ke bina koi request nahi chalti, aur **har request se pehle kill-flag check** hota hai. In `ask` mode **har** mouse/keyboard action ka approval aata hai; `trusted` me sirf read-only (screenshot/window-list/history) auto-run hote hain — clicks aur typing hamesha puchte hain.

### Safety rules jo har feature pe lagte hain

* **Kill switch**: UI ka red KILL button, global hotkey, ya Telegram `/kill` → turant sab laptop actions refused (flag file restart me bhi survive karti hai). Release: Laptop tab ka Resume ya `/resume`.
* **Prompt injection**: web page ka text / history ke titles `untrusted_content` mark hote hain — unse inspire hua desktop action approval ke bina nahi chalta.
* **Audit**: har desktop click, type, trash, download, history search, Telegram command Audit log me record hota hai.
* **Server local**: Studio khud hi 127.0.0.1 pe chalta hai + `AGENTSCOPE_API_TOKEN` (production me required) — bahar se laptop control possible nahi.

## Baaki Studio panels

| Panel | Kya karta hai |
|---|---|
| **Home** | Dashboard — health, counters, recent tasks, recent activity |
| **Providers** | Server-side provider config: enable/disable, priority, cost class, encrypted key, test connection, live model list, per-agent preferences, free-only mode |
| **Memory** | Durable user preferences (task se alag) + task notes; credential refuse |
| **Knowledge** | Document import + chunking + search with source citation |
| **Automation** | Schedules (disabled by default), duplicate-run prevention, cancel, run history |
| **Audit** | Poori privileged-action trail, filters ke saath |
| **System** | Unified status (DB, env, python, providers, tools, security) + permission policy + live command classification |

## Folder guide

| Path | Kya hai |
|---|---|
| `studio/src/lib/agentic/` | Engine: permissions, secrets, workspace, terminal, git, roles, orchestrator, crypto, audit, provider-store, memory, knowledge, automation |
| `studio/src/app/api/` | REST surface (47 routes) |
| `studio/src/components/studio/` | UI panels |
| `studio/python-bridge/runner.py` | Studio ↔ AgentScope Python bridge |
| `studio/scripts/windows/` | Windows setup / dev / prod / health-check / build scripts |
| `agentscope/` | AgentScope Python framework source (reference) |
| `studio/tests/` | Unit tests (`bun test`) |
| `studio/docs/` | Audit, implementation plan, test results, Windows guide |

## Troubleshooting

| Problem | Fix |
|---|---|
| `🐍 not installed` badge | `pip install agentscope` phir Studio restart |
| Port 3000 busy | 3000 free karo ya `start-dev.ps1 -Port 3001` |
| Prisma error | `npx prisma db push` dobara |
| Production me har API call 401 | `.env` me `AGENTSCOPE_API_TOKEN` set karo, ya browser ke **System** tab me token daal do |
| Agentic run slow | Fast provider key lagao (DeepSeek/Gemini) |

Poora troubleshooting table: [`studio/docs/WINDOWS_SETUP.md`](studio/docs/WINDOWS_SETUP.md) §7.


## Stonic Remote — phone se JARVIS (this session)

Audit ka point #6 (jo "confirm nahi hua" tha) ab bana hua hai aur chal raha hai.

**Kaise chalta hai**
1. PC par sidebar → **Remote** → *Generate code* (6 digit, 3 minute, ek hi baar).
2. Phone par wahi address + code: `http://<PC-IP>:3000/remote`
   (bahar se: `cloudflared tunnel --url http://localhost:3000` → jo https URL mile, wahi phone me kholo)
3. Phir mic dabao aur bolo — ya likho. Jawab wahi JARVIS deta hai jo PC par hai (same character,
   same memory) aur phone use **bol kar sunata** hai. Hands-free on ho to har jawab ke baad dobara sunta hai.

**Phone par kya chalta hai**
- Mic input: Android Chrome ka `SpeechRecognition` (`hi-IN`), na ho to text input
- Voice output: server TTS (`edge-tts` bridge) → na ho to phone ka `speechSynthesis`
- Transcript + replies screen par, "End" se session band

**Security (kyunki ye PC control kar sakta hai)**
| Rule | Value |
|---|---|
| Pairing code | 6 digit, 3 min TTL, sirf ek baar chalta hai, 5 galat par cancel |
| Brute force | per-client 10 attempts / minute |
| Session token | 256-bit, `timingSafeEqual`, sirf phone ke `sessionStorage` me |
| Idle expiry | 2 ghante |
| Max devices | 3 (purana apne aap hat jata hai) |
| Kill switch | pairing + messages dono refuse |
| Audit | pair / connect / message / revoke sab audit trail me (token kabhi nahi) |

PC se har device turant *Disconnect* ho sakta hai; phone ka `End` bhi session turant todta hai.
Remote transcript PC ke Chat list me `Remote · <device>` conversation bankar dikhta hai.

## Character, World Monitor & PC skills (this session)

Audit ke gaps par kaam — jo pehle missing/partial tha:

| Kya | Kaise | Note |
|---|---|---|
| **Character / persona** | sidebar → **Character** | 5 persona (JARVIS, F.R.I.D.A.Y, Buddy, Mentor, Studio), male/female/neutral avatar (SVG+CSS, idle/listening/thinking/speaking), nickname, humour + reply-length sliders, language. Server-side save, chat system prompt me inject |
| **World Monitor** | sidebar → **World** | Canvas globe (orthographic, drag + auto-rotate, pulsing hotspots), GDELT geo events (24 h) + live headlines, category filters, source-down par `degraded` banner |
| **PC slow kyun hai** | tool `pc-diagnose`, `GET /api/system/pc-health` | Asli CPU/RAM/disk/process numbers → ranked findings + score /100 (deterministic rules) |
| **Folder banana** | tool `folder-create` | Naya `mkdir` host action — approval-gated, allowed-roots ke andar |
| **Music control** | tools `music-play`, `music-control` | YouTube search / Spotify URI kholta hai; play/pause/next/prev/mute media keys se |
| **WhatsApp message** | tool `whatsapp-send` | WhatsApp Desktop me text pre-filled; **Send user dabata hai** (agent chup-chaap bhej nahi sakta) |
| **Screen awareness** | tool `screen-watch`, `/api/screen/watch` | Periodic screenshot → perceptual hash → change events; bank/password window par auto-pause; screenshots save nahi hote |

## Memory, clock & purani baatein — audit point #1

Audit ne kaha tha "voice + memory ka **long-term recall** asli me test nahi hua". Ab teeno cheezein
code me hain **aur** asli chat route se test ki gayi hain (`tests/memory-recall.test.ts`, 34 tests):

| Kya | Kaise | Note |
|---|---|---|
| **Naam / shehar / pasand yaad rehna** | chat me hi: "mera naam Ankit hai" | `recollect.ts` us baat ko pakadta hai (regex, koi extra model call nahi) aur wahi `memory.ts` store me daalta hai jise prompt padhta hai. Dobara bolne par row rewrite nahi hoti; naam badalne par update hoti hai |
| **"Aaj kaunsa din/date/time hai?"** | har prompt me real clock | `timeContext()` — weekday, date, time, timezone. Model andaza nahi lagata |
| **"Pichhli baar humne kya baat ki thi?"** | `conversation-recall` tool + auto-inject | asli transcripts me keyword search, top 5 excerpts, current chat chhod kar; block me saaf likha hai ki ye **data** hai, instructions nahi |
| **Sawaal yaad nahi bante** | `isQuestion()` | "mera naam kya hai?" kabhi memory me nahi jaata |
| **Password yaad nahi hota** | `saveMemory` refuse karta hai | credential dikhe to entry skip + reason, store nahi |

Phone (Stonic Remote) ko bhi wahi memory + clock milta hai — dono raaste ek hi store use karte hain.

Ab bhi baaki: **OCR** aur **Bluetooth**. Stonic Remote me awaaz turn-based hai (mic → model → TTS),
continuous WebRTC audio streaming nahi — uske liye relay/TURN infrastructure chahiye.

## Documents, file search, weather & news (latest session)

Studio ab wo cheezein bhi kar sakta hai jo pehle **missing** thi (`docs/CAPABILITY_MATRIX.md` me ✅ ho gayi hain):

| Kya | Kaise | Note |
|---|---|---|
| PDF / Word / Excel / PowerPoint / OpenDocument / RTF / EPUB **padhna** | `document-read` tool + knowledge base import | `src/lib/agentic/documents.ts` — **koi naya npm dependency nahi** (apna zip + pdf-stream parser) |
| Scanned PDF | detect hota hai aur saaf bolta hai ki OCR chahiye | OCR engine jaan-boojh kar nahi add kiya (bhaari dependency) |
| File dhoondhna — naam se **ya** file ke andar ke text se | `file-search` tool | line number + preview, read-only, `node_modules`/`.git` skip |
| Mausam | `weather-now` tool | Open-Meteo, **API key nahi** chahiye |
| News / headlines | `news-headlines` tool | public RSS (Google News), topic-wise |

Naye tools `/api/tools` aur `/api/tools/invoke` me register hain, permission `safe` hai
(kuch delete/write nahi karte), aur har path workspace ya allowed-roots guard se guzarta hai.

Teen naye test files: `tests/documents.test.ts`, `tests/document-tools.test.ts`,
`tests/info-tools.test.ts` — sab offline chalte hain (koi network/credential nahi).

## Bug-fix update — 8 real bugs fixed (latest session)

Poore project ka systematic bug audit: 2 HIGH (unsatisfiable-cron runaway cost loop, cancelled-task ka pending host-approval execute hona), 4 MEDIUM (silent morning-summary TTS, double morning summary non-UTC timezones me, vision null-coordinate click, tab-close par server-side mic leak), 2 LOW (Google OAuth login-CSRF, env-var NaN). Har fix ka regression test `tests/bugfix-regressions.test.ts` me — ab **773/773 tests pass**.

Details + fix-by-fix explanation: **studio/docs/BUGFIXES.md**
Pichhle session ke 7 Jarvis features ka guide: **studio/docs/JARVIS_FEATURES.md**

Setup (kuch naya install nahi):
`bun install` + `bunx prisma generate` + `bun run db:push`
`bun test` -> 773/773 pass hona chahiye
"# Jarvish" 
"# Jarvish" 
"# jarvish" 


## JARVIS reliability update

See [setup and verification notes](studio/docs/JARVIS_READINESS.md) for local setup,
security, tested fixes, and remaining deployment requirements.
