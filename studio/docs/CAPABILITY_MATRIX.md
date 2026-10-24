# Jarvis — feature list vs code (kya hai, kya nahi)

✅ = hai · 🆕 = is patch me add hua · 🟡 = aadha / doosre tool se ho jata hai · ❌ = nahi hai

Source: code me grep + padhna (Linux sandbox). Windows-only 🆕 features (brightness, WiFi, power,
close/min/max) maine **Windows pe chala ke nahi dekhe** — sirf input-validation aur approval-gate
tests chale. Pehli baar chalane par ek baar khud try karo.

## Communication
| Feature | Status | Kahan |
|---|---|---|
| Voice sunna (mic) | ✅ | `voice_bridge.py` wake word + `use-speech.ts` |
| Voice me jawab | ✅ | edge-tts, Hindi voice |
| Hindi/English baat-cheet | ✅ | LLM |
| Context yaad rakhna / follow-up | ✅ | conversations + `memory.ts` |
| Personality / tone set karna | 🟡 | per-agent prompt (Agent registry); dedicated tone setting nahi mila |

## Computer & System
| Feature | Status | Tool |
|---|---|---|
| App open | ✅ | `desktop-open-app` |
| App / window close | 🆕 | `desktop-close-window` (kai match ho to refuse) |
| Window minimize/maximize/restore | 🆕 | `desktop-window-state` |
| File list/read/write/delete (recycle bin) | ✅ | `file-*`, `host-tree`, host trash |
| File search / rename / move | 🟡 | `exec` (`mv`, `find`) approval ke saath; dedicated search tool nahi |
| Volume | ✅ | `desktop-volume` |
| Brightness | 🆕 | `desktop-brightness` (5–100, Windows panel) |
| WiFi on/off + status | 🆕 | `desktop-wifi-set` (Administrator chahiye), `desktop-wifi-status` |
| Bluetooth on/off | ❌ | workaround: `desktop-open-app` target `ms-settings:bluetooth` |
| Mouse / keyboard / typing / clipboard | ✅ | `desktop-click/type/hotkey/scroll/clipboard-*` |
| Screenshot | ✅ | `desktop-screenshot` |
| Screen recording | 🆕 | `desktop-screen-record` (max 60 s, kill switch rokta hai) |
| Shutdown / restart / sleep / hibernate | 🆕 | `desktop-power` (shutdown/restart par 15–300 s countdown, `cancel` se roko) |
| Lock | ✅ | `desktop-lock-screen` |
| System info (CPU/RAM/disk/battery) | 🆕 | `desktop-system-info` (read-only) |
| Webcam photo | 🆕 | `desktop-webcam-photo` |

## Internet & Web
| Feature | Status | Note |
|---|---|---|
| Website open / navigate / read page / click / fill | ✅ | `browser-*` (payment guard ke saath) |
| Downloads manage | ✅ | `download-file`, `downloads-digest/cleanup` |
| Google search, YouTube search | 🟡 | browser se search URL khol ke; dedicated search tool nahi |
| News / weather | ❌ | koi tool nahi (browser se ho sakta hai) |

## Data & Research
| Feature | Status | Note |
|---|---|---|
| Text / code docs summarize | ✅ | knowledge base |
| PDF / DOCX / XLSX padhna | ❌ | `knowledge.ts` inhe `unsupported` mark karta hai |
| OCR | ❌ | |
| Charts banana | ❌ | UI me recharts hai, agent tool nahi |

## Scheduling
| Feature | Status | Note |
|---|---|---|
| Calendar events + meeting reminders | ✅ | Google connector (create = approval) |
| Daily schedule / subah ka summary | ✅ | proactive morning summary |
| Recurring schedules | ✅ | automation + cron |
| To-do list, alarms (awaaz ke saath) | ❌ | goals/tasks hain, dedicated to-do/alarm nahi |

## Baaki
| Area | Status |
|---|---|
| Translation (text) | ✅ LLM; voice/real-time ❌ |
| Email padhna / bhejna / draft | ✅ (`gmail-list-messages` read-only, `host-email` approval) |
| Inbox organize / label / spam | ❌ (Gmail connector read-only) |
| Learning, quiz, code help | ✅ LLM |
| Proactive suggestions, quiet hours | ✅ |
| Paani / break / stretch reminders | ❌ (schedule bana ke ho sakta hai, built-in rule nahi) |
| Google Drive / OneDrive | ❌ (connector sirf Calendar + Gmail) |
| Telegram | 🟡 bot connector hai (Web control nahi) · WhatsApp ❌ |
| Music / playlist | 🟡 `desktop-open-app` se URL/file khulta hai; playlist ❌ |

## Safety (naye features par bhi)
- Har naya mutating endpoint `destructive` classify hota hai → **har baar approval**, trusted mode me bhi.
- Sirf `wifi_status` aur `system_info` read-only hain.
- Webcam, screen record, power kabhi auto-run nahi hote. Kill switch sab refuse karta hai.
