# AgentScope Studio — Windows Setup Guide

Complete, copy-pasteable instructions for Windows 10/11 (PowerShell 5.1 and
PowerShell 7 both work). Everything is relative to the project folder — there
is no machine-specific path anywhere in the code.

---

## 1. Prerequisites

| Tool | Required | Notes |
|---|---|---|
| [Bun](https://bun.sh) | recommended | fastest install & test runner. `powershell -c "irm bun.sh/install.ps1 | iex"` |
| Node.js 20+ | alternative | `winget install OpenJS.NodeJS.LTS` — use when Bun is unavailable |
| Python 3.10+ | optional | only needed for the AgentScope **Python bridge** (`pip install -e ../agentscope`) |
| Git | optional | needed by the agentic engine for snapshot/diff/rollback |

Check what you have:

```powershell
bun --version      # or: node --version
python --version   # optional
git --version      # optional
```

---

## 2. One-shot setup

```powershell
cd path\to\agentscope-suite\studio
powershell -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
```

The script performs, in order:

1. toolchain check (bun/node, optional python),
2. `bun install` (or `npm install`),
3. `.env` creation from `.env.example` **with a freshly generated**
   `AGENTSCOPE_API_TOKEN` and `AGENTSCOPE_SECRET_KEY`,
4. `prisma db push` (creates/updates `db/custom.db`),
5. `prisma generate`,
6. the test suite.

Useful switches:

```powershell
.\scripts\windows\setup.ps1 -SkipTests   # skip the test suite
.\scripts\windows\setup.ps1 -Force       # regenerate .env (new token + key)
```

> Re-running with `-Force` invalidates the previously stored provider API keys
> (they are encrypted with `AGENTSCOPE_SECRET_KEY`). Re-enter them in the
> **Providers** panel afterwards.

---

## 3. Running the Studio

### Development (hot reload)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1
# or, on another port:
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-dev.ps1 -Port 3001
```

Open <http://localhost:3000>.

### Production

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\build.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\windows\start-prod.ps1
```

The production build uses `output: 'standalone'`, so the server runs from
`.next/standalone/server.js` with a self-contained `node_modules` folder.

### The batch file

`..\..\start-studio.bat` (one level above `studio/`) installs, pushes the
schema and starts the dev server. It prefers `bun` and falls back to `npm`.

---

## 4. Health check

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\health-check.ps1
```

Output example:

```
  [OK]   health: ok (uptime 42s)
  [OK]   providers: 4 configured, 2 enabled, 1 with a key
  [OK]   tools: 12/12 healthy
  [WARN] python: not available - Optional: install the Python package ...
  [OK]   configuration: no issues

Result: HEALTHY
```

Exit codes: `0` healthy, `1` degraded, `2` server unreachable.

The same information is available in the UI: **System** tab (status +
permission policy) and **Dashboard** (overview).

---

## 5. Configuration

All variables live in `studio\.env` (created from `.env.example`).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `file:../db/custom.db` — the SQLite file |
| `AGENTSCOPE_API_TOKEN` | in production | Bearer / `x-agentscope-token` for mutating API calls |
| `AGENTSCOPE_SECRET_KEY` | recommended | 64 hex chars; encrypts provider API keys at rest |
| `AGENTSCOPE_PYTHON` | no | absolute path to the Python interpreter of the bridge |
| `AGENTSCOPE_ALLOW_UNAUTHENTICATED` | no | `1` disables the token check — **never** on a reachable network |
| `*_API_KEY` | no | provider keys from the environment (alternative to the UI) |

Generate a token and a key:

```powershell
[guid]::NewGuid().ToString('N')                                    # token
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
($bytes | ForEach-Object { $_.ToString('x2') }) -join ''           # secret key
```

**Provider keys entered in the UI** are stored **encrypted on the server**
(AES-256-GCM) and are never sent back to the browser — only a 4-character
hint is. Keys entered in `.env` stay in the environment.

The boot log reports configuration problems:

```
[env] WARNING AGENTSCOPE_API_TOKEN: AGENTSCOPE_API_TOKEN is not set — ...
[env] configuration OK — 3 variable(s) configured (values are never logged).
```

The same report is in the UI under **System → Status → Configuration**.

---

## 6. Windows-specific behaviour

| Topic | Behaviour |
|---|---|
| Workspace | `studio\.agentic-workspace\<taskId>\` — one isolated folder per task |
| Shell | the agentic engine runs commands through `cmd.exe` on Windows; `bash` steps are not available, so plans should use `python3`/`node`/`git` |
| Paths | the workspace guard rejects absolute paths, `..` traversal and symlink escapes on Windows too |
| SQLite | the file is locked while a write is in progress — do not open `db\custom.db` in an editor during a run |
| Long paths | enable *Settings → System → About → Enable long paths* if a deep workspace path fails |
| Firewall | the dev server binds to localhost; a Windows Firewall prompt is normal on the first run |
| Execution policy | `ExecutionPolicy Bypass` is used per command, so no permanent policy change is needed |

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `bun : command not found` | Bun not installed / not on PATH | install Bun, then open a NEW PowerShell window |
| `EACCES` / `EPERM` on `prisma db push` | the DB file is locked or read-only | close the dev server, delete `db\custom.db-journal` if it exists, retry |
| `PrismaClientInitializationError` | `DATABASE_URL` missing | run `setup.ps1` or set `DATABASE_URL=file:../db/custom.db` in `.env` |
| `Engine type "client" not supported` | the Prisma client was not generated | `bunx prisma generate` |
| Port 3000 already in use | another process owns the port | `start-dev.ps1 -Port 3001` or `netstat -ano | findstr :3000` |
| `Module not found: @prisma/client` | dependencies out of sync | `bun install && bunx prisma generate` |
| Every API call returns 503 | production without a token | set `AGENTSCOPE_API_TOKEN` in `.env` and restart |
| `🐍 AgentScope: not installed` | the Python package is missing | `pip install -e ..\agentscope` and restart the Studio |
| Provider test fails with `fetch failed` | no network / proxy | check `HTTPS_PROXY`, try `ollama` locally |
| `Unauthorized` in the browser | a token is required and the browser does not send it | open the UI from the same origin, or set `AGENTSCOPE_ALLOW_UNAUTHENTICATED=1` for local work |
| Stale UI after a change | dev cache | delete `.next` and restart the dev server |
| Task stuck in `awaiting_approval` | a destructive command needs approval | approve the **exact** command shown in the task panel |
| Audit trail empty | audit writes are best-effort | check the console for `[audit] failed to persist audit entry:` |

---

## 8. Uninstall / reset

```powershell
# stop the server first
Remove-Item -Recurse -Force .\node_modules, .\.next
Remove-Item -Force .\db\custom.db        # removes all tasks, memory, knowledge, automations
```

A backup of the database is kept at `db\custom.db.pre-completion.bak` from the
migration that introduced the audit, provider, memory, knowledge and automation
tables — copy it back if you ever need the pre-migration state.
