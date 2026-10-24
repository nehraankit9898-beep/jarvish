# Bug-fix update — 8 real bugs fixed (is session ka audit)

Ye session poore project ka **systematic bug audit** tha: 773 existing tests +
typecheck + eslint sab pehle se pass the, isliye bugs wo LOGIC bugs the jo
tests cover nahi karte. Deep code review se 8 real bugs mile — sab fix hue,
aur har fix ke liye regression test add hua (`tests/bugfix-regressions.test.ts`,
11 tests). Ab **773/773 tests pass** (ye 11 included).

---

## HIGH severity

### Bug #1 — Runaway cron loop (automation + cron)
- **Problem:** Unsatisfiable cron (jaise `0 0 30 2 *` = Feb 30) ka
  `nextRunAt = null` ban jata tha, aur `runDueSchedules` use "due" samajh ke
  **har 30-second tick pe naya task + LLM plan** chala deta tha — bina kisi
  kaam ke paisa/credits jalte rehte.
- **Fix:** (a) cron scan window 1 saal → 4 saal (ab Feb 29 leap-day bhi
  resolve hota hai), (b) create-time pe invalid cron **reject** hota hai,
  (c) `nextRunAt = null` wali legacy rows kabhi "due" nahi maani jati,
  (d) recovery aisi purani rows ko safe re-arm kar deta hai.

### Bug #2 — Cancelled task ka approval phir bhi execute hota tha (orchestrator + host-control)
- **Problem:** Screen task cancel karte hi pending host-approval (mouse click
  waghera) pending hi reh jata tha. 10 min tak loop block, late "approve"
  click **CANCELLED task ka action REAL laptop par** chala deta, aur timeout
  ke baad `blocked` status `cancelled` ko overwrite kar deta tha.
- **Fix:** Naya `cancelHostApprovalsForTask()` — cancel route pending action
  drop + approval waiter ko "denied" se jagata hai (audit ke sath).
  `finishScreenTask` ab terminal status (cancelled/done/failed) kabhi
  overwrite nahi karta.

## MEDIUM severity

### Bug #3 — Morning summary TTS kabhi bolta nahi tha (studio UI)
- **Problem:** Mount-only React effect first-render ka `tts.speak` closure
  pakad leta tha jisme `enabled=false` hota tha — hands-free summary silent.
- **Fix:** `ttsRef` pattern — hamesha fresh speak function use hota hai.

### Bug #4 — Morning summary din me 2 baar fire hoti thi (proactive)
- **Problem:** UTC date-key + local-hours gate mix — UTC+9:30 jaise timezones
  me summary subah + dopahar dono baar aati thi.
- **Fix:** `localDateKey()` helper — key ab laptop ke LOCAL calendar date se
  banti hai (exported, test coverage ke sath).

### Bug #5 — Vision screen-task cursor par (0,0) click kar sakta tha (vision)
- **Problem:** `parseScreenAction` `{"action":"click"}` (bina coordinates) ya
  `x: null` accept kar leta tha — bridge cursor ki jagah par click kar deta.
- **Fix:** `isPlausibleAction()` — click ko real finite `x + y` mandatory,
  type/hotkey/open ko apna payload mandatory, null ab 0 me coerce nahi hota.

### Bug #6 — Tab band karne par server-side mic chalta rehta tha (use-speech)
- **Problem:** Hands-free on + tab close → cleanup sirf flag set karta tha,
  server-side wake-word mic band nahi hota tha.
- **Fix:** Unmount par `stop` fetch (keepalive) + `pagehide` par `sendBeacon`
  — mic ab page ke sath hi band.

## LOW severity

### Bug #7 — Google OAuth login CSRF (connectors)
- **Problem:** OAuth `state` generate hota tha par verify kabhi nahi hota —
  attacker apna Google account victim ke Studio se bind kar sakta tha.
- **Fix:** Issue route httpOnly `state` cookie set karta hai; callback state
  match + single-use enforce karta hai.

### Bug #8 — Empty/garbage env vars se NaN behaviour (proactive + vision)
- **Problem:** `AGENTSCOPE_PROACTIVE_DAILY_CAP=''` → cap 0 (sab suppressed),
  garbage → NaN (unlimited spam); `SCREEN_MAX_STEPS` NaN → har screen task
  instantly fail.
- **Fix:** `envPositiveInt()` sanitizer dono jagah — invalid value par safe
  default.

---

## Kya verify hua

- `tests/bugfix-regressions.test.ts` — 11 regression tests (sab pass)
- Full suite: **773/773 pass** (44 files) · `tsc` clean (src/) · eslint
  0 errors
- Audit me ye bhi clear hue (non-issues): approvalWaiters leak nahi hai,
  runTask recursion terminate hota hai, cron DST math sahi, telegram
  offset/inFlight sahi, google refresh clock-skew handled

## Aapko kya karna hai

Kuch naya install nahi. Bas zip nikaalo aur:

```
bun install
bunx prisma generate
bun run db:push
bun test          # 773/773 dikhna chahiye
```
