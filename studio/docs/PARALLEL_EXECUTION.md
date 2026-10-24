# Parallel multi-agent execution + live progress

Pichhle engine me ek hi waqt me sirf **read-only** steps (analyze / research)
parallel chalte the, aur baaki sab kuch ek-ek karke. Matlab: do independent
`implement` steps ho to unka poora LLM thinking time bhi serial hi lagta tha.

Ab engine **waves** me chalta hai: jo steps ek doosre par depend nahi karte wo
**ek saath** chalte hain, aur UI me **live board** dikhta hai ki kaunsa agent
abhi kya kar raha hai, kitni der se.

Sab kuch purane safety layer ke andar hai — koi approval, lock ya audit rule
hataaya nahi gaya.

---

## 1. Ek wave kaise banti hai?

`src/lib/agentic/parallel.ts` (pure, deterministic — koi LLM call nahi):

| Rule | Matlab |
|---|---|
| dependency | jis step ke `blocks` dependencies pass/skip nahi hue, wo wave me nahi aata |
| read-only | `analyze` / `research` steps hamesha ek saath chal sakte hain |
| writers | `implement` / `test` / `docs` / `security` / `debug` steps sirf tab ek saath jab planner ne unke files declare kiye hon aur wo **disjoint** hon |
| undeclared writer | jo step apni files declare nahi karta wo **akela** chalta hai (safe default) |
| plan order | koi writer apne se **pehle** wale writer ko overtake nahi karta — pehle wala terminal ho ya usi wave me ho. Isliye purane plans (jahan `blocks` dependency bhool gaye) bhi strictly ordered chalte hain |
| limit | ek wave me max `parallelism` agents (1-4, default 3) |
| writer cap | ek wave me max **2** writers (12 GB laptop par 4 heavy writers thrash karte hain) |

Example:

```
#1 analyze        ─┐
#2 implement a.py ─┤  → wave 1: teen agents ek saath
#3 implement b.py ─┘

#4 implement b.py (dubara)   → #3 ke saath conflict, isliye wave 2 me
#5 test (blocks: 2,3,4)      → wave 3
#6 review                    → sab likhne ke baad (wave executor drain hone ka wait)
```

Do writers ek hi file par kaam karte hon to planner ko `blocks` dependency
daalni chahiye — planner prompt me ye rule explicitly likha gaya hai.

### Writes phir bhi serialized hain

Parallel writers ka matlab "do agents ek saath file likh rahe hain" **nahi**
hai. `executeStep` ab workspace lock sirf **critical sections** par leta hai:

```
thinking (LLM)  → lock nahi
writing files   → lock  ← claimPaths + applyFileActions + filesChanged
commands        → lock  ← build/test/scripts
snapshot        → lock  ← git snapshot + step status
```

Yaani do writers apne **thinking time** me overlap karte hain (asli speedup),
lekin workspace mutation kabhi overlap nahi hota. Agar phir bhi koi undeclared
conflict aata hai to `WriteConflictError` us step ko fail karta hai — chupchaap
overwrite nahi hota.

---

## 2. Settings

Per run (UI ke **Live agents** card me, ya API se):

| Setting | Default | Kahan |
|---|---|---|
| `parallelism` | 3 (1-4) | UI: Agents 1/2/3/4 buttons · API: run/resume body |
| `parallelWrites` | `true` | UI: switch · API: run/resume body |
| `AGENTSCOPE_PARALLEL_WRITES=0` | — | `.env` — writes parallel band karne ka **global kill switch** |

```bash
curl -X POST http://localhost:3000/api/agentic/tasks/<id>/run \
  -H 'Content-Type: application/json' \
  -d '{"parallelism": 2, "parallelWrites": true}'
```

Invalid values silently default par chale jaate hain (99 → 4, "abc" → 3).

`parallelism: 1` = purana serial behaviour — writers bhi ek-ek karke.

---

## 3. Live progress board

`⚡ Live agents — 2/3 busy` card har task ke upar dikhta hai:

* overall progress bar + `passed / running / queued / failed / skipped` counts,
* har running agent ka **phase**: `Thinking → Writing files → Running commands
  → Repair → Snapshot → Done`,
* live elapsed timer (server se aaya `elapsedMs` + client ka tick),
* attempt number aur detail line,
* last wave ka reason timeline me: `Wave: 2 agent(s) parallel · disjoint-scope writers`.

Naye events (sab SSE stream me, `seq` ke saath persisted — refresh/reconnect par
bhi board reconstruct ho jaata hai):

| Event | Kya |
|---|---|
| `wave_start` | is wave me kaun se steps, kyun (reason), limit |
| `step_progress` | phase + elapsedMs + detail + attempt (10s heartbeat while thinking) |
| `progress` | task-level counts + percent (har wave/step ke baad) |

`GET /api/agentic/tasks/<id>` me ab `progress` field bhi aata hai, to pehla
render bina event replay ke bhi sahi hota hai.

---

## 4. Do executors, ek hi step kabhi nahi

Do runner hain — **wave executor** (background, independent steps) aur
**serial loop** (dependency chains, review, approvals). Purane code me ek
read-only step dono se start ho sakta tha. Ab:

* in-process `claimed` set — check + insert synchronous, isliye race nahi,
* step row turant `running` ho jaati hai (board bhi isse dikhata hai),
* resume par orphaned `running` step wapas `pending` ho jaata hai (warna task
  hamesha ke liye atak jaata),
* approval gate khula ho to dono loop ruk jaate hain — koi step approval ko
  overtake nahi karta.

---

## 5. Bugs jo end-to-end test ne pakde (aur fix hue)

Ye test sirf "green tick" nahi tha — isne 4 asli bugs surface kiye:

| Bug | Kya hota tha | Fix |
|---|---|---|
| **Do executors ek hi plan se** | serial loop + wave executor dono steps uthate the → `parallelism: 1` bhi parallel chalta tha, aur ek writer aise writer ke saath chal sakta tha jiska scope overlap karta ho | serial loop ab **sirf** approval ke baad resume hone wala step continue karta hai; wo step pehle hi claim ho jaata hai |
| **Read-only step ka git snapshot lock ke bahar** | do agents ek saath `git commit` karte → `.git/index.lock` conflict, task fail | snapshot **hamesha** workspace lock ke andar (`runSnapshotLocked`) |
| **Wave executor ka crash chup-chaap nigal liya jaata tha** | task `done` dikhta tha jabki steps `running` me atke rehte | crash ab `error` event + task `failed` (reason ke saath) |
| **Workspace apna git repo na ho to parent repo me likhna** | `.git` missing hone par `git add/commit` upar wale (user ke) repo me chalta tha, uske index.lock se takraata tha | `ensureOwnRepo()` — snapshot/diff/baseline se pehle; `ensureRepo` pehle workspace dir banata hai |

## 6. Test

```bash
bun test tests/parallel.test.ts                    # 35 pure unit tests
bun test tests/parallel-waves.integration.test.ts  # 4 end-to-end tests
```

**Unit** (`parallel.test.ts`) — clamping, path-scope conflicts (`src` vs
`src/a.ts`, case/backslash), undeclared writer, plan-order barrier, disjoint
writers, writer cap, dependency blocking, failed dependency, running step
re-schedule, ordered `boundedMap` (concurrency peak bhi assert hota hai),
progress counting aur planner ke `files` parsing + sanitization
(`/etc/passwd`, `..`, `C:\` drop).

**Integration** (`parallel-waves.integration.test.ts`) — asli orchestrator,
asli workspace + asli git snapshots; sirf DB (`tests/helpers/fake-db.ts`, ek
in-memory Prisma-shim) aur LLM (injected `complete`) fake hain:

1. do disjoint writers **sach me** ek saath chalte hain (peak concurrent LLM
   calls ≥ 2) aur har step **exactly ek baar** chalta hai;
2. same file wale do writers kabhi overlap nahi karte (peak writers = 1);
3. `parallelism: 1` par LLM kabhi do baar ek saath nahi bulaya jaata;
4. live events (`wave_start`, `step_progress` phases, `progress`) emitted +
   monotonic `seq` ke saath replayable hain.

Baaki suite: `bun test` → 773 + naye tests pass hone chahiye.
