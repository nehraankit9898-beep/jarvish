# Google Connector setup (Calendar + Gmail) — Jarvis #7

Jarvis ko aapke Google Calendar aur Gmail tak pahunchane ke liye EK baar ye setup karna hai.
Tokens AES-256-GCM se encrypt ho kar Studio ke database me rehte hain — UI me kabhi nahi dikhte.

## Niyam (jo code me already lagaye gaye hain)

- **Read pehle**: Calendar list + Gmail list default read-only tools hain.
- **Write hamesha approval ke saath**: `calendar-create-event` tool `destructive`
  permission ke saath registered hai — event/reminder banne se PEHLE aapse poochha jayega.
- **Gmail kabhi send nahi karta** — sirf padhta hai (never marks as read).
- Email bhejna aaj bhi purane SMTP connector se hota hai (wahi approval gate).

## Step-by-step (5 minute)

1. **Google Cloud Console** kholo: <https://console.cloud.google.com/>
2. Naya project banao (ya existing chuno) → top-left project dropdown → *New Project*.
3. **APIs enable karo** — *APIs & Services → Library*:
   - **Google Calendar API** → Enable
   - **Gmail API** → Enable
4. **OAuth consent screen** — *APIs & Services → OAuth consent screen*:
   - User Type: **External** → Create
   - App name: `AgentScope Jarvis`, apni email daal do
   - **Test users** me apna Gmail address ADD karo (zaroori — warna consent block hoga)
5. **Credentials banao** — *Credentials → Create Credentials → OAuth client ID*:
   - Application type: **Web application**
   - **Authorized redirect URIs** me ye daalo (Studio ka URL + path):
     ```
     http://localhost:3000/api/connectors/google/callback
     ```
     (Studio doosre port/host pe ho to wahi URI badal kar use karo; `AGENTSCOPE_PUBLIC_URL`
     env var set karne se redirect URI khud usi ke hisaab se banta hai.)
6. **Client ID aur Client Secret copy karo** → Studio ke `.env` me daalo:
   ```
   AGENTSCOPE_GOOGLE_CLIENT_ID=1234-abcd.apps.googleusercontent.com
   AGENTSCOPE_GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
   ```
7. Studio restart karo → **System panel → Connectors → Connect Google** dabao.
   Consent screen pe apna account chuno aur "Allow" kar do. Tab khud band ho jayegi.

## Kaise use kare

Chat me bas bolo:
- "kal ki meetings batao"
- "aaj ke important mail dikhao"
- "kal subah 10 baje reminder laga do — doctor appointment"  → approval aayega

Ya Agentic/Tools panel me naye tools dekho: `calendar-list-events`,
`calendar-create-event` (destructive → approval), `gmail-list-messages`.

## Troubleshooting

| Dikkat | Ilaaj |
|---|---|
| `redirect_uri_mismatch` | Console wale redirect URI ko EXACTLY wahi copy karo jo upar likha hai (trailing slash nahi) |
| `access_denied` | OAuth consent screen → Test users me apna email add karo |
| `invalid_grant` | Token expire — System panel → Disconnect, phir Connect Google dobara |
| Calendar read fails | Google Calendar API enable karna bhool gaye |
| Gmail read fails | Gmail API enable karo; Gmail readonly scope consent me aayega |

## Token security

- Access + refresh tokens `ConnectorToken` table me **AES-256-GCM encrypted**
  (`AGENTSCOPE_SECRET_KEY` se) store hote hain (`db/.secret-key` fallback).
- Tokens API responses me KABHI return nahi hote — sirf account email + scopes dikhte hain.
- Disconnect karne par tokens Studio se delete ho jate hain; Google side ka refresh
  token revoke karne ke liye <https://myaccount.google.com/permissions> se app hatado.
