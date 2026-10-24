# JARVIS setup and readiness

## Run locally

Requires Node.js 20.19+ (22 LTS recommended), npm, and network access for dependencies
and Prisma engine downloads on first setup.

```sh
cd studio
npm ci
npm run setup
npm run dev
```

Setup preserves existing `.env` files, creates a private encryption key only when
needed, generates Prisma Client, and applies the SQLite schema without reset or
`--accept-data-loss`. Back up existing databases before schema changes. Keep `.env`
and `db/.secret-key` secure and backed up; losing the encryption key can make saved
provider credentials unreadable.

Open **API Setup**, choose a provider, configure its key/model, **Test Connection**,
and select it for chat. Server-managed Providers stores keys encrypted. A saved key,
an enabled provider, or an installed Ollama client is **not proof of connectivity**.
The dashboard now reports successful *last tests*, not a fabricated live-online count.
Retest after changing keys/models or network conditions.

For production, set a strong `AGENTSCOPE_API_TOKEN` in server environment, enter the
matching token in browser Settings, then run `npm run build && npm start`. Do not
publish tokens with `NEXT_PUBLIC_*` variables. Do not disable production authentication.
Production frame protection remains enabled; only development permits Arena embedding.

## What changed

- Fixed npm peer dependency conflict between next-auth and Nodemailer.
- Bundled fonts from npm instead of fetching Google Fonts during builds.
- Development binds to all interfaces and supports Arena preview hosts.
- Added a safe, repeatable setup command.
- Health endpoint no longer exposes raw database errors/paths and disables caching.
- Connection-test API rejects malformed JSON, null bodies, non-string settings and
  oversized fields with HTTP 400 before any provider request.
- Dashboard clears stale system/provider state on failed refresh, displays actionable
  connectivity errors, supports manual refresh, and labels provider test results honestly.
- Added a subtle HUD grid, useful starter commands, provider onboarding, mobile-sized
  input text, IME-safe Enter handling and reduced-motion CSS.

## Validation in this sandbox

- TypeScript check: passed.
- Production build: passed.
- 61 targeted tests: passed (API guards, JARVIS, voice regressions, connection validation).
- Prisma binary download is blocked by the sandbox's outbound network restrictions.
  Client types were generated with `--no-engine` for compile validation **only**. This
  is not a runnable SQLite engine. Run normal `npm run setup` on a machine with Prisma
  download access before using the database; do not use `--no-engine` for local SQLite.
- No provider credentials were supplied; a real model response was **not** verified.
  This sandbox also restricts outbound access to provider hosts.

## Real-world capability limits

Browser voice requires HTTPS/localhost, microphone permission, and a supported
speech-recognition implementation. Desktop/PC automation operates on the machine
running the backend/desktop bridge, not automatically on the browser user's PC.
Optional Python, voice, desktop bridges and background worker require their own
installation/configuration. Start the worker explicitly with `npm run worker` when
needed (requires Bun). Approval gates and the kill switch remain in place. This is
an assistant interface with real integrations, not an autonomous movie-style AI.
