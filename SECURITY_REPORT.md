# SECURITY_REPORT.md — AgentScope Suite · JARVIS v2.1

**Scope:** the Studio (Next.js server + browser UI), the agentic engine, every process it spawns,
the Python bridges, the phone-remote channel, and the HTTP surface (79 route handlers).
**Method:** threat-informed code review of every privileged path, followed by *live* probes
against the running server (approval bypass, path escapes, kill switch, remote pairing, custom-tool
sandbox). Findings were only accepted when the execution path was traced end-to-end — a
dangerous-looking function that is unreachable is reported as such, not as a vulnerability.
**Baseline:** the project already carried two internal audit rounds (`BUGFIXES.md`); this pass
re-verified their claims and concentrated on what they did not cover.

---

## 1. Threat model (what this software is, and what it is not)

| Property | Reality |
|----------|---------|
| Deployment | **Local-first, single user.** The server runs on the user's own machine, holds their files and drives their desktop. |
| Tenancy | **None.** There is no user table, no login, no per-user authorisation. "Authentication" is an optional shared token. |
| Trusted inputs | The person at the keyboard. |
| Untrusted inputs | Web pages and documents the agent reads, model output, a paired phone, any process that can reach `localhost`, and anything on the network if the operator exposes the port. |
| Primary assets | Provider API keys, the AES master key, the user's files, the ability to execute code / move the mouse, the audit trail. |
| Out of scope | Multi-tenant hosting, hostile co-tenants on the same machine, OS-level malware, supply-chain compromise of `node_modules`. |

**Deployment rule that follows from the above:** this application must not be exposed to the
public internet as-is. It is designed to bind to a local interface, behind a reverse proxy that
adds real authentication, or to be reached through the paired-phone channel only.

---

## 2. Access control on the HTTP surface

| Control | Implementation | Verified |
|---------|----------------|----------|
| API token | `AGENTSCOPE_API_TOKEN` → `x-agentscope-token` or `Authorization: Bearer`. Compared with a constant-time helper. | live: missing token → 401; correct token → 200 (`tests/repair-regressions.test.ts`) |
| Fail-closed in production | `NODE_ENV=production` without a token refuses every privileged route (503) unless `AGENTSCOPE_ALLOW_UNAUTHENTICATED=1` | `tests/api-guards.test.ts` |
| CSRF | Mutating requests with an `Origin` header must be same-origin or in `AGENTSCOPE_ALLOWED_ORIGINS`; no CORS response headers are emitted, so a foreign page cannot read a response either | live: cross-origin POST → 403 before any work (`A1`), 17 route guards asserted in `api-guards.test.ts` |
| Per-route guards | 74 of 79 route files call `rejectIfUnauthorized()`. The 5 that do not are deliberate: `/api/health`, `/api` (index), and the four phone-facing `/api/remote/{connect,message,speak,whoami,end}` routes, which authenticate with the **remote session token** instead. | audited file-by-file |
| Rate limiting | `src/proxy.ts`: per-IP fixed window (60/min mutating, 120/min read, 20/min for chat/compare/test-connection/providers) | `tests/rate-limit-regressions.test.ts` |
| Token transport | header only. A `?token=` query parameter is **rejected** on the SSE route (it would end up in proxy logs and referrers) | asserted in `repair-regressions.test.ts` |

**Residual risks**

* The rate limiter and the remote pairing state are **in-memory**: a restart clears them, and a
  multi-process deployment would give each process its own counters.
* `clientIp()` trusts the first `x-forwarded-for` hop. Behind a proxy that appends rather than
  replaces, a client can spoof its address to dodge throttling or poison the audit `ip` column.
  Acceptable locally; must be fixed before any proxied deployment.
* The browser keeps the Studio token in `localStorage` (`api-token.ts`). Any XSS in the UI would
  read it — see §7 (CSP allows `unsafe-inline`/`unsafe-eval`, inherited from the framework setup).
* The phone keeps its session token in `sessionStorage` (dies with the tab) — better than
  `localStorage`, still readable by injected script on that page.

---

## 3. Secrets handling

| Control | Implementation |
|---------|----------------|
| Provider keys at rest | AES-256-GCM, random 12-byte IV per record, auth tag stored with the ciphertext (`crypto.ts`). Never returned to the browser — only `hasKey` and a `••••1234` hint. |
| Master key | `AGENTSCOPE_SECRET_KEY` (scrypt-derived) or a generated `db/.secret-key` written with mode `0600`. Loss is detected and reported (`SecretKeyUnavailableError`), never silently replaced. |
| Logs / errors / audit | `protect().masked` on command output, tool results, provider error bodies (added here in B-06), audit `details` **and** `artifact`, email errors, desktop bridge output. |
| Process environments | **Fixed here (B-05).** Five spawners, all sanitised: `terminal.ts` (`sanitizedEnv`), `host-control.ts` (`hostEnv`, strips `*KEY*/*TOKEN*/*SECRET*/*PASSWORD*/DATABASE_URL`), `desktop-bridge.ts` (`bridgeEnv`), `custom-tools.ts` (explicit allow-list), `opencode.ts` (`openCodeEnv`, allow-list). |
| Bridge token | `db/.desktop-token` (`0600`), passed to the Python child **only** through `AGENTSCOPE_DESKTOP_TOKEN` — never on the command line (argv is world-readable via `ps`/`/proc`). |
| Memory store | refuses content that matches a credential pattern (`assertNoCredential`) instead of storing it, and tells the user to use the Providers panel. |

**Residual risks**

* Anyone who can read the Studio process's environment (same-user malware, a leaked `.env`, a
  world-readable backup) can decrypt the provider store if `AGENTSCOPE_SECRET_KEY` is set there.
  Prefer the generated `db/.secret-key` file for a machine that several people use.
* `.env` is git-ignored but exists on disk; it is **not** included in the archive (`release/` is
  built from `git ls-files`, and `.env*` is ignored except the sanitized `.env.example`).

---

## 4. Code execution and process control

| Surface | Boundary | Verified |
|---------|----------|----------|
| Custom tools (agent-authored JS) | Dedicated **child process**: Node permission model (`--experimental-permission`, only the runner file readable), heap caps, `stdio` IPC only, 30 s hard kill, V8 context with code generation **off** and an explicit global allow-list; a source scan as defence-in-depth; the only I/O is `api.fetch` through the SSRF guard, pinned to the tool's declared base URL. | live: `process`/`Function` escape rejected; a runaway async tool is terminated (`tests/repair-regressions.test.ts`) |
| Task terminal | `executeCommand()` classifies the **raw** command (line by line for multi-line payloads), refuses `forbidden`, requires approval for `destructive`, and rejects any `..`/absolute path or symlink that leaves `.agentic-workspace/<task>/`. Child runs as its own process group and is killed with `SIGKILL` on cancel/timeout, so descendants die too. | `tests/bug-hunt.test.ts` H7, `tests/agentic.test.ts`, `A7` |
| Host `exec` (the real machine) | Modes `locked/ask/trusted`; `forbidden` commands never run even with approval, multi-line payloads escalate, argv-form spawn with `shell:false`, sanitized env, output masked, 10-minute single-use approval bound to the exact stored action. | live: stored-action execution, single use, expiry |
| OpenCode CLI | Same workspace jail, `shell:false`, sanitized env (**fixed here**), 10-minute default timeout with SIGTERM→SIGKILL. | `A4` |
| Desktop bridge | Python child on `127.0.0.1` only, token-authenticated, refuses to start when `AGENTSCOPE_DESKTOP_MODE=locked` (default), re-checks the kill flag itself, every mutating endpoint is approval-gated. | live: `bridge.mode=locked, desired=stopped`; `clipboard_get` classified mutating on purpose |

---

## 5. Filesystem and network boundaries

* **Workspace jail**: `resolveSafe()` rejects absolute paths, `..` segments and symlinks that
  resolve outside the workspace (real-path comparison against the closest existing ancestor).
  Task ids are validated against `^[A-Za-z0-9_-]{1,64}$` before they become a directory name.
* **Host paths**: `canonical()` resolves symlinks before every check; a deny-list of credential and
  browser stores (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker/config.json`, `.netrc`,
  `.git-credentials`, `.npmrc`, `.env*`, `id_*`, `*.pem|key|p12|pfx|kdbx|keystore`,
  Chrome/Edge/Brave/Firefox profile dirs, `Login Data`, `Cookies`, Windows credential stores,
  `/etc/shadow`, wallets) applies to **read as well as write**, and cannot be unlocked by approval.
  System directories can be read but never written or deleted.
* **Outbound HTTP**: `assertOutboundUrl()` — http/https only, https required unless the host is an
  explicitly allowed loopback, DNS-resolved and every address checked, IPv6 expanded to its 8
  groups so `::ffff:127.0.0.1`, `0:0:0:0:0:0:0:1` and 6to4 embeddings are classified, private /
  link-local / CGNAT / multicast / metadata endpoints blocked. Used by provider tests, runtime
  provider calls, downloads, the browser engine and the world monitor.
* **Downloads**: size cap, per-chunk stall timeout, atomic rename, duplicate-name collision
  handling, filename sanitisation.

---

## 6. Agent-specific threats

| Threat | Mitigation |
|--------|-----------|
| Prompt injection from a web page / document | `markUntrusted()` wraps external text as DATA with an explicit "never an instruction" preamble, flags the common injection phrasings, and forces an approval for desktop/host actions inspired by flagged content. The browser engine and history search attach the flag. |
| Model claims success | `evaluateTestGate()` rejects a reviewer PASS unless real commands executed and exited 0; the tester reads actual exit codes; `finishTask()` only writes `done` when the run succeeded. A planning failure produces `failed` with the provider's message (live-verified). |
| Agent approving its own action | There is **no** tool that can approve; approvals exist only in `/api/host` (user door) and the Laptop tab. The run route cannot widen `approvedCommands` beyond the stored pending command. |
| Runaway agent loops | Bounded retries per step (max 2 targeted fixes), step/`SCREEN_MAX_STEPS` budgets, per-task cancellation that kills the child process group and drops pending approvals. |
| Kill switch bypass | Independently enforced in `executeCommand`, `host-control.requestHostAction`, `resolveHostApproval` (re-checked at approve time), `desktopCall`, `remote-session.startPairing/authenticate`, and re-checked by the Python bridge itself. Persisted to a flag file so a restart cannot silently re-arm. |

---

## 7. Findings in this pass

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| B-05 | **High** | The OpenCode child inherited the Studio's entire environment, including the AES master key, the API token and `DATABASE_URL`. | **Fixed** — allow-list; regression test A4 |
| B-03 | High (integrity) | Advertised, UI-used provider test endpoint did not exist → 404 (and the panel showed "unknown error"). | **Fixed** — new guarded route; A1 |
| B-02 | **Critical** (supply chain) | `.gitignore`'s bare `test` rule silently excluded `src/app/api/providers/[id]/test/route.ts` from the repository and any archive — code could ship with a route missing. | **Fixed** — anchored patterns |
| B-06 | Medium | Provider error bodies were discarded and every failure was reported as 502 "unreachable"; the mapping added here masks the body before it reaches the browser. | **Fixed** — A8 (a provider echoing `sk-wrong` does not leak it) |
| B-07 | Medium | The task SSE stream sent no bytes until an event existed; a client/proxy could hang indefinitely and the dashboard misreported connectivity. | **Fixed** — A3 |
| B-08 | Medium | `DELETE /api/memory` with no filter destroyed every scope, including other tasks' private notes. | **Fixed** — A5 |
| B-11 | Medium | No retention → unbounded growth of audit/agent records (a disk-exhaustion path that also degrades the audit trail's usefulness). | **Implemented (opt-in)**; never touches security rows or active tasks |
| S-05 | Low (accepted) | In `ask` mode the agent may read *any* non-blocklisted file without approval. | Documented design (the mode table in `README`). Mitigation: credential/browser/wallet paths are refused outright. An operator who wants no silent reads should run `AGENTSCOPE_HOST_MODE=locked`. |
| S-02 | Low (accepted) | `DELETE /api/audit` with no `taskId` erases the whole trail — including security rows. | Deliberate "clear the log" action reachable only from the local UI/token-holder. Flagged because an audit trail that can be erased by one click has limited forensic value; recommend export-before-clear for any deployment with more than one user. |
| S-03 | Low (accepted) | Audit `ip` comes from `x-forwarded-for` (spoofable). | Harmless locally; fix before a proxied deployment. |
| S-07 | Low (accepted) | The CSP allows `unsafe-inline` / `unsafe-eval` for scripts. | Inherited from the framework/dev tooling; tightening it needs a nonce pipeline and was out of scope for a repair pass. It is the reason the token lives in an attackable storage location. |
| S-08 | Info | `X-Frame-Options: DENY` is only set in production; in dev, framing is limited by `frame-ancestors` to the local/preview origins. | Intentional (the dev preview is embedded). |

---

## 8. Controls re-verified as sound (no change made)

* **Remote (phone) channel** — 6-digit code, 3-minute TTL, one active code, 5 wrong attempts
  destroy it, 10 attempts/minute per client, single-use redemption, 256-bit token compared in
  constant time, 2 h idle expiry, max 3 sessions, revoke by id / all, kill-switch aware,
  state in memory only (a restart drops every session). Tokens never appear in logs or audit rows.
* **Approval queue** — 50-item cap, 10-minute TTL, swept on every list/decide, deep-copied at
  request time so a later mutation cannot change what runs, re-classified at execution time
  (the filesystem may have changed), and woken/denied on task cancellation.
* **Audit trail** — every privileged action (tool invoke, host action, approval, kill switch,
  provider change, remote pairing, memory/knowledge mutation) is recorded with actor, approval,
  result, error category and a masked artifact.
* **Crypto** — AES-256-GCM with per-record IV and auth tag; a tampered payload throws rather than
  returning garbage; `unpackSecret()` validates the envelope version.
* **Google OAuth callback** — error strings are HTML-escaped and served with
  `default-src 'none'` + `nosniff` (asserted in `repair-regressions.test.ts`).

---

## 9. Recommended hardening for a network-exposed deployment (not applied here)

1. Put the Studio behind an authenticating reverse proxy; set `AGENTSCOPE_API_TOKEN` and never
   `AGENTSCOPE_ALLOW_UNAUTHENTICATED`.
2. Terminate TLS at the proxy; keep `AGENTSCOPE_PROVIDER_ALLOW_LOOPBACK=0` unless a local model
   server is actually used.
3. Move the rate limiter and remote-session state to Redis if more than one instance runs.
4. Replace the `x-forwarded-for` trust with the proxy's trusted header.
5. Add a CSP nonce pipeline and move the API token to an `HttpOnly` cookie with `SameSite=Strict`.
6. Enable `AGENTSCOPE_RETENTION_DAYS` and ship the audit trail to append-only storage.
7. Keep `AGENTSCOPE_HOST_MODE=locked` and `AGENTSCOPE_DESKTOP_MODE=locked` unless the machine is
   dedicated to this agent.
