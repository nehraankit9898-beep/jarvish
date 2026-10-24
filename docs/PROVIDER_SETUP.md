# Gemini and OpenRouter — configuration & testing

Everything below is done in the app UI (**Settings → Providers**, or JARVIS → **AI Brain**). The same data is
stored encrypted on the server; you never edit a JSON file by hand.

---

## 1. Google Gemini

### Get a key
1. Open <https://aistudio.google.com/apikey> and sign in.
2. **Create API key** → copy it. Treat it like a password.
3. If the key belongs to a Google Cloud project, make sure the *Generative Language API* is enabled for it.

### Configure
| Field | Value |
|---|---|
| Provider | `Gemini` |
| Base URL | `https://generativelanguage.googleapis.com/v1beta` (prefilled — do not append `/chat/completions`) |
| Model | `gemini-3.8-flash` (prefilled) |
| API key | your key |

Click **Test connection**.

* **Success:** `Connected — verified with a real request` and the model id is echoed. A real request was sent
  and real text came back.
* **Failure:** the panel names the category and shows the provider's sanitized message; the key is never
  displayed or logged.

### Models
`gemini-3.8-flash` (default), `gemini-3.6-flash` (retires **2026-11-19**), `gemini-3.5-flash`,
`gemini-3.5-flash-lite`, `gemini-3.1-pro`, `gemini-3-flash`, `gemini-4-argon`.
**`gemini-2.5-*` was shut down on 2026-10-20** and `1.5`/`2.0` are long retired — if one is still saved, the
app replaces it with the default and **tells you** (toast + speech). Other wrong ids are reported as
**Model unavailable**, never silently rewritten.

Use **Refresh** in the model picker to fetch the live list from `GET /v1beta/models`. Live results are labelled
**Live**; a cached copy says **Cached** with its timestamp; the built-in list says **Built-in catalog (not live)**.

### Common errors
| Message | Meaning |
|---|---|
| Authentication failed | key invalid, revoked, or from a different project |
| Model unavailable | id not enabled for this key / region — refresh and pick a live one |
| Rate limited | quota exhausted; the hint shows the retry window |
| Blocked response | safety filter refused the prompt — not a connection problem |
| Empty response | the model returned nothing usable — reported as a failure, never as "connected" |

---

## 2. OpenRouter

### Get a key
1. Open <https://openrouter.ai/keys> → **Create key**.
2. Copy it (shown once).

### Configure
| Field | Value |
|---|---|
| Provider | `OpenRouter` |
| Base URL | `https://openrouter.ai/api/v1` (prefilled) |
| Model | `openrouter/free` (prefilled, free auto-router) |
| API key | your key |

OpenRouter receives `Authorization: Bearer <key>` plus the `HTTP-Referer`/`X-Title` attribution headers.
No query-string key.

### Free models
* Free models use the `:free` suffix (e.g. `openrouter/free`, `openai/gpt-oss-120b:free`,
  `qwen/qwen3.8-27b:free`, `google/gemma-4-31b-it:free`). The list changes weekly — always use **Refresh**
  instead of typing an id from memory.
* Free tier limits are roughly **20 requests/minute** and **50 requests/day** (or 1000/day with a one-time
  $10+ top-up).
* **The app will never switch you to a paid model on its own.** If the selected free model is unavailable
  you get *"OpenRouter ka selected model available nahi hai"* and a deliberate choice list.

### Common errors
| Message | Meaning |
|---|---|
| Authentication failed (401/403) | key invalid or disabled |
| Rate limited (429/402) | daily free quota exhausted or account out of credits |
| Model unavailable (404) | id retired/restricted — refresh the list |
| Provider-server error (5xx) | OpenRouter or the upstream model is down; retry later |

---

## 3. Verifying with curl (optional)

Gemini:

```bash
curl -s -H "x-goog-api-key: $GEMINI_API_KEY" \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent" \
  -H "content-type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}],"generationConfig":{"maxOutputTokens":10}}'
```

A success contains a `candidates[0].content.parts[0].text`. An auth failure contains an `error.status` of
`INVALID_ARGUMENT`/`PERMISSION_DENIED`/`UNAUTHENTICATED`.

OpenRouter:

```bash
curl -s https://openrouter.ai/api/v1/models | head -c 400          # live catalog, no key needed
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "content-type: application/json" \
  -d '{"model":"openrouter/free","messages":[{"role":"user","content":"Say OK"}],"max_tokens":10}'
```

**Never paste a real key into a shell you do not control, and never into a file that is committed.**

---

## 4. Where the settings live

| Layer | Stored where | Contains |
|---|---|---|
| Server (authoritative) | SQLite `ProviderConfig` | `apiKeyEnc` (AES-256-GCM), `baseUrl`, `model`, enabled, cost class, last test |
| Browser | `localStorage` | provider id, model, base URL, `keyHint`/`serverStored`, verification signature — **not the key** |
| API responses | — | `hasKey`, `keyHint`, timestamps, sanitized errors only |

Changing the model or base URL after a successful test clears the **Connected** badge until the new
configuration passes its own test. That is deliberate: *saved is not connected*.

---

## 5. If you must use environment variables

`studio/.env` supports last-resort keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, …) for headless/production
setups. They are read only when no server-stored credential exists. Keep `.env` out of git — the repository
already ignores it and ships `.env.example` with placeholders only.
