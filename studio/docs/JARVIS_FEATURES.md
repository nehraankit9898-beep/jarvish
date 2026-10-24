# AgentScope Jarvis — 7 naye features ka guide

Ye guide `new.......2.txt` wale spec ke hisaab se banaye gaye 7 features ka
setup + use + test tarika hai. Sab kuch approval/kill-switch safety ke ANDAR
hai — koi feature laptop ke bina poochhe kuch nahi chhootta.

## Order (jo spec me tha, wahi follow hua)

| # | Feature | Status | Kahan dikhta hai |
|---|---------|--------|------------------|
| 4 | Memory (yaaddasht) | ✅ | Memory panel, Chat, har task ke prompts |
| 3 | Natural awaaz (edge-tts) | ✅ | Chat composer ka TTS button |
| 1 | Wake word ("Hey Jarvis") | ✅ | Chat composer ka Radar (hands-free) button |
| 6 | Startup + tray | ✅ | `scripts/windows/install-studio.ps1` + `python-bridge/tray.py` |
| 5 | Proactive | ✅ | Dashboard ka Suggestions card + subah ka summary |
| 7 | Calendar/Gmail | ✅ | System panel → Connectors |
| 2 | Vision (screen task) | ✅ | Chat me "screen dekh kar …" bolo |

---

## 1. Memory (#4)

- Har naye kaam se pehle agent ko sirf **relevant 5-10 yaadein** milti hain
  (keyword-scored — poora list prompt ko lamba nahi banata).
- Agent khud bhi yaad rakh sakta hai: step ke reply me
  `### REMEMBER: key :: fact` likhta hai (max 5 per step, passwords REFUSED).
- Tools panel me naye tools: `memory-remember`, `memory-recall`, `memory-forget`.
- Memory panel me har yaad **edit** ho sakti hai aur "Forget this" delete —
  agent ki yaadon par `agent` badge lagta hai.

**Test kaise:** Memory panel me daalo `work start time` = "subah 9 baje".
Chat me pucho "mera kaam kab start hota hai?" — jawab me yaad dikhegi.

## 2. Natural awaaz (#3) + 3. Wake word (#1)

Dono ek hi naye **voice bridge** (`python-bridge/voice_bridge.py`, port 8792,
sirf 127.0.0.1, token-auth) me hain:

```powershell
pip install -r python-bridge\requirements-voice.txt
```

- **TTS**: jawab ab edge-tts (Hindi `hi-IN-MadhurNeural` default) se bolta hai.
  edge-tts na ho to khud browser voice par fallback. Code blocks/tables bolna
  nahi — server-side sanitize hota hai. **Interrupt**: aap bolna shuru karo ya
  Stop dabao — awaaz turant rukti hai.
- **Wake word**: Chat composer me **Radar button** = Hands-free ON.
  openWakeWord ka offline `hey_jarvis` model mic sunta hai (CPU halka; audio
  kabhi store nahi hota). "Jarvis" sunte hi Studio chat khol kar mic on kar
  deta hai. **Sensitivity slider** right-click panel me — galat trigger
  kam/zyada. Mic indicator (hara dot) + tray mute dono kaam karte hain.
- **Echo guard**: jab Jarvis bol raha ho ya mic khula ho, wake word pause.

**Test kaise (spec ke hisaab se):** "Jarvis" 20 baar bolo (kitne pakde), TV
ya gaane ke saath 10 minute chalao (kitni galat jaga). Sensitivity usi hisaab
se set karo.

## 4. Startup + tray (#6)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-studio.ps1
```

- **AgentScope Studio** task: logon pe production server (`bun run start`,
  hidden, crash par auto-restart 99x). Dev mode nahi — i3 + 12 GB RAM bachao.
- **AgentScope Tray** task: `python-bridge/tray.py` — tray icon:
  HARÁ = ready · PEELA = Studio offline · LAAL = kill switch · SLATE = paused.
  Menu: Open Studio / Mute mic / Pause Jarvis / Kill switch / Resume.
  Tray wahi kill-flag file likhta hai jo Studio's safety.ts padhta hai.
- Purana worker task (`install-worker.ps1`) waise hi kaam karta hai.

**Test kaise:** Laptop restart karo — Studio + tray khud chal jayenge. Tray me
Kill switch dabao → Studio me laptop actions refused; Resume se wapas.

## 5. Proactive (#5)

- **Roz subah ka summary** (default 09:00, `AGENTSCOPE_MORNING_SUMMARY` se
  badlo): pending approvals + kal ke tasks + nayi downloads + schedules ka
  chhota digest — notification + Telegram dono pe, TTS on ho to bol kar bhi.
- **Event triggers**: 30+ din purani Downloads files → cleanup suggestion;
  30 min se atka task → inspect suggestion; (purane 4 rules bhi active).
- **Spam se bachav**: quiet hours (`AGENTSCOPE_QUIET_HOURS`, default
  23:00–07:30), din me max 5 proactive notifications
  (`AGENTSCOPE_PROACTIVE_DAILY_CAP`), aur har card par **"Mat batao"** button
  — us type ka suggestion phir kabhi nahi aayega.
- **"Haan kar do"**: chat me ye likho/bolo aur sabse naya open suggestion
  accept ho kar task ban jata hai (plan → approvals wahi purane).

## 6. Calendar/Gmail (#7)

`docs/GOOGLE_CONNECTOR_SETUP.md` follow karo (Google Cloud OAuth, 5 min).
Naye tools: `calendar-list-events` (safe), `gmail-list-messages` (safe, sirf
padhna), `calendar-create-event` (**destructive — hamesha approval**).

## 7. Vision (#2)

Chat me bolo: **"screen dekh kar notepad me hello likho"** — task
`mode: screen` me banta hai:

1. Screenshot (desktop bridge) → 1280px downscale (sharp) → cloud vision model
2. Model EK action lauta hai: click/type/hotkey/scroll/open/wait/done/cannot
3. Read-only + `wait` chalte hain; **har click/type/hotkey/scroll/open
   approval maangta hai** (ask mode; trusted me bhi log hota hai)
4. Naya screenshot → repeat, max 25 steps (`AGENTSCOPE_SCREEN_MAX_STEPS`)
5. **Payment/password/bank window** dikhi → task khud ruk jata hai
6. Har step 2–5 second (API call) — ek kaam me 10–20 calls lag sakte hain

⚠️ **Privacy (seedhi baat):** screenshots cloud model ko jaati hain. Task
shuru hote hi Studio ek notification me ye yaad dila deta hai. Local vision
model i3 pe practical nahi hai.

**Test kaise:** Pehle simple — "notepad kholo aur hello likho". Approval
popup aayega (Laptop panel), approve karo, phir typing. Phir mushkil kaam.

---

## Pehli baar chalane se pehle (schema badla hai)

```
bun install
bunx prisma generate
bun run db:push        # ConnectorToken + ProactiveState + AgenticTask.mode
```

## Naye env vars (sab optional, `.env.example` me documented)

`AGENTSCOPE_VOICE_BRIDGE`, `AGENTSCOPE_VOICE_PORT`, `AGENTSCOPE_TTS_VOICE`,
`AGENTSCOPE_WAKE_SENSITIVITY`, `AGENTSCOPE_WAKE_MODEL_DIR`,
`AGENTSCOPE_PORCUPINE_KEY`, `AGENTSCOPE_MORNING_SUMMARY`,
`AGENTSCOPE_QUIET_HOURS`, `AGENTSCOPE_PROACTIVE_DAILY_CAP`,
`AGENTSCOPE_SCREEN_MAX_STEPS`, `AGENTSCOPE_SCREEN_WIDTH`,
`AGENTSCOPE_GOOGLE_CLIENT_ID/SECRET`, `AGENTSCOPE_PUBLIC_URL`

## Kya verify hua / kya nahi

- ✅ 762 tests pass (20 naye Jarvis tests included), `tsc --noEmit` clean
- ✅ Sandbox me Studio UI, API routes, voice/wake endpoints, connectors OAuth
  flow, screen-task routing — browser se check kiye
- ⚠️ Jaisi sandBox me NAHI chal sakta: real mic wake-word (Windows + mic
  chahiye), edge-tts network synthesis (pip install chahiye), tray icon,
  Task Scheduler — ye user ke Windows laptop pe test karne hain. Python files
  ka syntax check ho chuka hai.
