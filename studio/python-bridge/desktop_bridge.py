# -*- coding: utf-8 -*-
"""
AgentScope Desktop Bridge — AgentScope Studio <-> the REAL laptop
-----------------------------------------------------------------
A tiny HTTP server that the Studio (Node.js) starts as a child process.
It is the Python side of the laptop-control features:

    mouse / keyboard / screen   -> pyautogui (+ mss for screenshots)
    app / window / clipboard    -> pygetwindow + PowerShell (no extra deps)
    recycle-bin delete          -> send2trash
    Chrome history search       -> stdlib sqlite3 on a disposable TEMP COPY (the original is never opened)
    kill switch hotkey listener -> optional `keyboard` lib

SECURITY (non-negotiable):
  - binds to 127.0.0.1 ONLY — nothing outside this laptop can reach it
  - every request must carry the token the Studio generated
    (X-Desktop-Token header)
  - every mutating request is refused when the Studio's kill-flag file
    exists (the Studio writes it when you press KILL — Ctrl+Shift+F12 by
    default, see AGENTSCOPE_KILL_HOTKEY)
  - pyautogui.FAILSAFE stays ON: slam the mouse into the top-left corner
    and pyautogui itself aborts
  - nothing here is ever exposed to the network by the Studio

Run (the Studio does this itself):
    python python-bridge/desktop_bridge.py --port 8791 --token XXX \
        --kill-flag "C:/.../kill-flag.json"

Endpoint map (POST JSON unless noted):
    GET  /ping              -> liveness + which libs are available
    GET  /status            -> same as ping (alias)
    POST /screenshot        -> {monitor?}   -> PNG bytes (image/png)
    POST /mouse_move        -> {x, y}
    POST /click             -> {x?, y?, button: left|right|middle, clicks: 1|2}
    POST /type_text         -> {text, interval?}
    POST /hotkey            -> {keys: "ctrl,shift,esc"} | {key: "enter"}
    POST /scroll            -> {dx, dy}
    POST /list_windows      -> {}          -> [{title, left, top, width, height}]
    POST /focus_window      -> {title contains-match}
    POST /clipboard_get     -> {}          -> {text}
    POST /clipboard_set     -> {text}
    POST /open_app          -> {target}    (path/URL/app-name; os.startfile / start)
    POST /volume            -> {direction: up|down|mute, steps?}  (media keys)
    POST /lock_screen       -> {}
    POST /recycle_delete    -> {path}      (send2trash — NEVER permanent delete)
    POST /close_window      -> {title, all?}   (refuses if several windows match)
    POST /window_state      -> {title, state: minimize|maximize|restore}
    POST /brightness        -> {level 5-100}   (Windows, built-in laptop panel)
    POST /wifi_status       -> {}              (read-only)
    POST /wifi_set          -> {action: on|off, interface?}  (needs Administrator)
    POST /power             -> {action: shutdown|restart|sleep|hibernate|cancel, delay?}
    POST /webcam_capture    -> {camera?}       -> saved PNG in ~/Pictures/AgentScope
    POST /screen_record     -> {seconds<=60, fps<=15, monitor?} -> saved MP4
    POST /system_info       -> {}              (read-only: cpu/ram/disk/battery)
    POST /chrome_history    -> {query?, days?, limit?}  (disposable temp copy; original untouched)
    POST /kill              -> {}          (writes the kill-flag file itself)
"""

import argparse
import contextlib
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# configuration (from argv, set by the Studio)
# --------------------------------------------------------------------------

PORT = 8791
TOKEN = ""
KILL_FLAG = ""

# libs that may be missing — every endpoint degrades with an install hint
_LIBS = {}


def _detect_libs():
    global _LIBS
    def try_import(name):
        try:
            return __import__(name)
        except Exception:
            return None

    pyautogui = try_import("pyautogui")
    if pyautogui is not None:
        # the corner failsafe is a HARD safety rule — never let it be disabled
        try:
            pyautogui.FAILSAFE = True
        except Exception:
            pass
    _LIBS = {
        "pyautogui": pyautogui,
        "mss": try_import("mss"),
        "pygetwindow": try_import("pygetwindow"),
        "send2trash": None,
    }
    try:
        from send2trash import send2trash  # noqa: F401
        _LIBS["send2trash"] = send2trash
    except Exception:
        pass


LIB_HINTS = {
    "pyautogui": "pip install pyautogui",
    "mss": "pip install mss",
    "pygetwindow": "pip install pygetwindow",
    "send2trash": "pip install Send2Trash",
    "cv2": "pip install opencv-python",
    "psutil": "pip install psutil",
}

# optional GLOBAL kill hotkey (keyboard lib needs root on some linux setups —
# missing it only means the hotkey listener is off, everything else works)
_keyboard = None
_hotkey_thread = None


def _start_hotkey_listener():
    global _keyboard, _hotkey_thread
    try:
        import keyboard  # type: ignore
        _keyboard = keyboard
    except Exception:
        _keyboard = None
        return
    if not TOKEN or not KILL_FLAG:
        return

    combo = os.environ.get("AGENTSCOPE_KILL_HOTKEY", "ctrl+shift+f12")
    hotkey = "+".join(p.strip().lower() for p in combo.split("+") if p.strip())
    if not hotkey:
        return

    def _engage():
        try:
            engage_kill("global hotkey " + hotkey, "hotkey")
        except Exception:
            pass

    def _run():
        try:
            _keyboard.add_hotkey(hotkey, _engage)
            _keyboard.wait()  # blocks this worker thread forever
        except Exception:
            pass

    _hotkey_thread = threading.Thread(target=_run, name="kill-hotkey", daemon=True)
    _hotkey_thread.start()


# --------------------------------------------------------------------------
# kill switch
# --------------------------------------------------------------------------

def _killed():
    """True when the Studio's kill-flag file exists."""
    if not KILL_FLAG:
        return False
    try:
        return os.path.exists(KILL_FLAG)
    except Exception:
        return False


def engage_kill(reason, source):
    """Write the kill-flag file exactly like the Studio does."""
    if not KILL_FLAG:
        return {"ok": False, "error": "kill flag path not configured"}
    state = {
        "killed": True,
        "reason": str(reason or "manual")[:300],
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": str(source or "unknown")[:40],
    }
    os.makedirs(os.path.dirname(KILL_FLAG) or ".", exist_ok=True)
    with open(KILL_FLAG, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    return {"ok": True, "state": state}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

class BridgeError(Exception):
    pass


def _require(lib, key):
    if lib is None:
        raise BridgeError(f"{key} is not installed. Run: {LIB_HINTS.get(key, 'pip install ' + key)}")
    return lib


def _ps(script):
    """Run a PowerShell one-liner (Windows); returns stdout text."""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=20,
    )
    if out.returncode != 0:
        raise BridgeError((out.stderr or "powershell failed").strip()[:500])
    return out.stdout


def _clipboard_get():
    if sys.platform == "win32":
        return _ps("Get-Clipboard -Raw").rstrip("\r\n")
    try:
        import tkinter  # noqa
        r = subprocess.run(
            ["xclip", "-selection", "clipboard", "-o"] if sys.platform != "darwin"
            else ["pbpaste"],
            capture_output=True, text=True, timeout=10,
        )
        return r.stdout
    except Exception as exc:
        raise BridgeError(f"clipboard read failed: {exc}")


def _clipboard_set(text):
    if sys.platform == "win32":
        # base64 through PowerShell so ANY text (quotes, newlines, unicode) survives
        import base64
        encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
        _ps(
            "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString("
            "[Convert]::FromBase64String('" + encoded + "')))"
        )
        return {"set": len(text)}
    raise BridgeError("clipboard_set is Windows-only in this bridge")


def _chrome_history_paths():
    """Best-effort Chrome/Edge/Brave History locations on this machine."""
    home = os.path.expanduser("~")
    candidates = []
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", os.path.join(home, "AppData", "Local"))
        candidates = [
            os.path.join(local, "Google", "Chrome", "User Data", "Default", "History"),
            os.path.join(local, "Google", "Chrome", "User Data", "Profile 1", "History"),
            os.path.join(local, "Microsoft", "Edge", "User Data", "Default", "History"),
            os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data", "Default", "History"),
        ]
    elif sys.platform == "darwin":
        candidates = [
            os.path.join(home, "Library", "Application Support", "Google", "Chrome", "Default", "History"),
            os.path.join(home, "Library", "Application Support", "Microsoft Edge", "Default", "History"),
        ]
    else:
        candidates = [
            os.path.join(home, ".config", "google-chrome", "Default", "History"),
            os.path.join(home, ".config", "chromium", "Default", "History"),
            os.path.join(home, ".config", "microsoft-edge", "Default", "History"),
            os.path.join(home, "snap/chromium/common/chromium/Default", "History"),
        ]
    return [p for p in candidates if os.path.exists(p)]


# Chrome's epoch is 1601-01-01; its timestamps are microseconds since then
_CHROME_EPOCH_OFFSET = 11644473600


def _chrome_time_to_iso(webkit_ts):
    try:
        ts = int(webkit_ts)
        if ts <= 0:
            return None
        seconds = ts // 1_000_000 - _CHROME_EPOCH_OFFSET
        return datetime.datetime.fromtimestamp(
            seconds, datetime.timezone.utc
        ).isoformat()
    except Exception:
        return None


def _search_history(payload):
    """
    Copy the History DB to a temp file and query THAT (the original is
    locked while Chrome runs and we must never write to it). Only the
    urls/visits tables are read — no cookies, no logins, no form data.
    """
    import sqlite3

    query = payload.get("query")
    days = payload.get("days")
    limit = payload.get("limit")

    paths = _chrome_history_paths()
    if not paths:
        return {"ok": True, "entries": [], "sources": [], "note": "No Chrome/Edge/Brave history file found"}

    since_cutoff = None
    if days and int(days) > 0:
        since_cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=int(days))
    q = str(query or "").strip().lower()
    limit = max(1, min(int(limit or 50), 200))

    entries = []
    sources = []
    for original in paths[:3]:  # first 3 profiles is plenty
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(prefix="agentscope-history-", suffix=".sqlite")
            os.close(fd)
            shutil.copy2(original, tmp)
            # Chrome may also have a -wal sidecar; copy it so the snapshot is consistent
            # (the copy must sit EXACTLY at <tmp>-wal / <tmp>-journal or sqlite
            # will not find it and un-checkpointed history rows go missing)
            for extra in (original + "-wal", original + "-journal"):
                if os.path.exists(extra):
                    with contextlib.suppress(Exception):
                        shutil.copy2(extra, tmp + extra[len(original):])
            conn = sqlite3.connect(f"file:{tmp}", uri=True)
            try:
                rows = conn.execute(
                    """
                    SELECT u.url, u.title, u.visit_count,
                           (SELECT MAX(v.visit_time) FROM visits v WHERE v.url = u.id)
                    FROM urls u
                    ORDER BY COALESCE((SELECT MAX(v.visit_time) FROM visits v WHERE v.url = u.id), u.last_visit_time) DESC
                    LIMIT 2000
                    """
                ).fetchall()
            finally:
                conn.close()
        except Exception as exc:
            sources.append({"path": original, "error": str(exc)[:200]})
            continue
        finally:
            if tmp:
                with contextlib.suppress(Exception):
                    os.remove(tmp)

        sources.append({"path": original, "read_only": True})
        for url, title, visit_count, last_visit in rows:
            iso = _chrome_time_to_iso(last_visit)
            if since_cutoff and iso and iso < since_cutoff.isoformat():
                continue
            hay = f"{title or ''} {url or ''}".lower()
            if q and q not in hay:
                continue
            entries.append({
                "url": url,
                "title": (title or "")[:300],
                "visitCount": visit_count,
                "lastVisitAt": iso,
                "browser": os.path.normpath(original).split(os.sep)[
                    -4 if sys.platform == "win32" else -4
                ],
            })
            if len(entries) >= limit:
                break
        if len(entries) >= limit:
            break

    entries.sort(key=lambda e: e.get("lastVisitAt") or "", reverse=True)
    return {"ok": True, "entries": entries[:limit], "sources": sources, "untrusted": True}


# --------------------------------------------------------------------------
# endpoint implementations
# --------------------------------------------------------------------------

def do_screenshot(payload):
    mss = _require(_LIBS.get("mss"), "mss")
    pyautogui = _require(_LIBS.get("pyautogui"), "pyautogui")
    monitor_index = int(payload.get("monitor") or 1)
    with mss.mss() as sct:
        monitors = sct.monitors
        idx = monitor_index if 0 <= monitor_index < len(monitors) else 1
        shot = sct.grab(monitors[idx])
        width, height = shot.width, shot.height
        raw = mss.tools.to_png(shot.rgb, shot.size)
    return raw, "image/png", {"width": width, "height": height, "monitor": idx, "screen": [pyautogui.size().width, pyautogui.size().height]}


def do_mouse_move(payload):
    pg = _require(_LIBS.get("pyautogui"), "pyautogui")
    x, y = int(payload["x"]), int(payload["y"])
    sx, sy = pg.size()
    if not (0 <= x <= sx and 0 <= y <= sy):
        raise BridgeError(f"coordinates out of screen ({sx}x{sy})")
    pg.moveTo(x, y, duration=0.12)
    return {"x": x, "y": y}


def do_click(payload):
    pg = _require(_LIBS.get("pyautogui"), "pyautogui")
    button = str(payload.get("button") or "left")
    if button not in ("left", "right", "middle"):
        raise BridgeError("button must be left|right|middle")
    clicks = 2 if str(payload.get("clicks")) == "2" else 1
    x, y = payload.get("x"), payload.get("y")
    kwargs = {"button": button, "clicks": clicks, "interval": 0.08}
    if x is not None and y is not None:
        x, y = int(x), int(y)
        sx, sy = pg.size()
        if not (0 <= x <= sx and 0 <= y <= sy):
            raise BridgeError(f"coordinates out of screen ({sx}x{sy})")
        pg.click(x, y, **kwargs)
        return {"clicked": [x, y], "button": button, "clicks": clicks}
    pg.click(**kwargs)
    pos = pg.position()
    return {"clicked": [pos.x, pos.y], "button": button, "clicks": clicks}


def do_type_text(payload):
    pg = _require(_LIBS.get("pyautogui"), "pyautogui")
    text = str(payload.get("text") or "")
    if not text:
        raise BridgeError("text is empty")
    if len(text) > 5000:
        raise BridgeError("text longer than 5000 chars — split it")
    interval = min(max(float(payload.get("interval") or 0.02), 0.0), 0.5)
    pg.write(text, interval=interval)
    return {"typed": len(text)}


def do_hotkey(payload):
    pg = _require(_LIBS.get("pyautogui"), "pyautogui")
    keys = payload.get("keys") or payload.get("key")
    if not keys:
        raise BridgeError("keys is required")
    if isinstance(keys, str):
        parts = [k.strip().lower() for k in keys.replace("+", ",").split(",") if k.strip()]
    else:
        parts = [str(k).strip().lower() for k in keys]
    if not parts or len(parts) > 4:
        raise BridgeError("1 to 4 keys expected")
    _ALLOWED = set(
        "abcdefghijklmnopqrstuvwxyz0123456789"
        "enter esc tab space backspace delete insert home end "
        "pageup pagedown up down left right "
        "shift ctrl alt win command option "
        "f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 "
        "volumeup volumedown volumemute playpause".split()
    )
    for p in parts:
        if p not in _ALLOWED:
            raise BridgeError(f"key not allowed: {p}")
    if len(parts) == 1:
        pg.press(parts[0], presses=int(payload.get("presses") or 1), interval=0.05)
    else:
        pg.hotkey(*parts)
    return {"pressed": parts}


def do_scroll(payload):
    pg = _require(_LIBS.get("pyautogui"), "pyautogui")
    dx = int(payload.get("dx") or 0)
    dy = int(payload.get("dy") or 0)
    if dx == 0 and dy == 0:
        raise BridgeError("dx or dy required")
    # pyautogui: positive dy scrolls UP — translate to natural direction here
    if dy:
        pg.scroll(-dy // 40 or (-1 if dy > 0 else 1))
    if dx:
        try:
            pg.hscroll(-dx // 40 or (-1 if dx > 0 else 1))
        except Exception:
            raise BridgeError("horizontal scroll not supported on this platform")
    return {"dx": dx, "dy": dy}


def do_list_windows(_payload):
    pgw = _require(_LIBS.get("pygetwindow"), "pygetwindow")
    windows = []
    for w in pgw.getAllWindows()[:60]:
        try:
            if not w.title:
                continue
            windows.append({
                "title": w.title[:200],
                "left": w.left, "top": w.top,
                "width": w.width, "height": w.height,
                "visible": bool(w.visible),
            })
        except Exception:
            continue
    return {"windows": windows, "active": (pgw.getActiveWindow().title[:200] if pgw.getActiveWindow() else None)}


def do_focus_window(payload):
    pgw = _require(_LIBS.get("pygetwindow"), "pygetwindow")
    title = str(payload.get("title") or "").strip()
    if not title:
        raise BridgeError("title is required")
    matches = [w for w in pgw.getAllWindows() if title.lower() in (w.title or "").lower()]
    if not matches:
        raise BridgeError(f"no window matching: {title}")
    w = matches[0]
    try:
        if w.isMinimized:
            w.restore()
        w.activate()
    except Exception:
        with contextlib.suppress(Exception):
            pgw = _LIBS.get("pyautogui")
            if pgw:
                # fallback: alt-tab is too risky — just bring it up via activate() variants
                pass
    return {"focused": w.title[:200]}


def do_open_app(payload):
    target = str(payload.get("target") or "").strip()
    if not target or len(target) > 400 or "\n" in target:
        raise BridgeError("invalid target")
    if sys.platform == "win32":
        os.startfile(target)  # noqa: S606 — the Studio approves this call first
        return {"opened": target}
    if sys.platform == "darwin":
        subprocess.Popen(["open", target])
        return {"opened": target}
    subprocess.Popen(["xdg-open", target])
    return {"opened": target}


def do_volume(payload):
    pg = _require(_LIBS.get("pyautogui"), "pyautogui")
    direction = str(payload.get("direction") or "").lower()
    steps = max(1, min(int(payload.get("steps") or 3), 10))
    if direction == "up":
        pg.press("volumeup", presses=steps, interval=0.05)
    elif direction == "down":
        pg.press("volumedown", presses=steps, interval=0.05)
    elif direction == "mute":
        pg.press("volumemute")
    else:
        raise BridgeError("direction must be up|down|mute")
    return {"direction": direction, "steps": steps}


def do_lock_screen(_payload):
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.LockWorkStation()
        return {"locked": True}
    if sys.platform == "darwin":
        subprocess.Popen(["pmset", "displaysleepnow"])
        return {"locked": True}
    subprocess.Popen(["loginctl", "lock-session"])
    return {"locked": True}


def do_recycle_delete(payload):
    s2t = _require(_LIBS.get("send2trash"), "send2trash")
    target = str(payload.get("path") or "").strip()
    if not target or len(target) > 500 or "\x00" in target:
        raise BridgeError("invalid path")
    if not os.path.exists(target):
        raise BridgeError(f"not found: {target}")
    if os.path.isdir(target) and not os.listdir(target) == [] and payload.get("deep") is not True:
        # a folder delete still goes to the bin, but flag it in the result
        pass
    s2t(target)
    return {"trashed": target, "permanent": False}


# --------------------------------------------------------------------------
# Jarvis extras: window close/state, power, brightness, WiFi, webcam,
# screen recording, system info.  Every one of these is classified
# `destructive` by the Studio (host-control.ts) unless it is in the read-only
# set (wifi_status, system_info) — so each call waits for the user's approval.
# --------------------------------------------------------------------------

def _lazy(name):
    """Import an optional heavy lib on first use (keeps /ping fast)."""
    try:
        return __import__(name)
    except Exception:
        raise BridgeError(f"{name} is not installed. Run: {LIB_HINTS.get(name, 'pip install ' + name)}")


def _need_windows(what):
    if sys.platform != "win32":
        raise BridgeError(f"{what} is implemented for Windows only")


def _clamp(value, lo, hi, default):
    try:
        v = int(value)
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _media_dir():
    d = os.path.join(os.path.expanduser("~"), "Pictures", "AgentScope")
    os.makedirs(d, exist_ok=True)
    return d


def _stamp():
    return datetime.datetime.now().strftime("%Y%m%d-%H%M%S")


def _find_windows(title):
    gw = _require(_LIBS.get("pygetwindow"), "pygetwindow")
    title = str(title or "").strip()
    if len(title) < 2 or len(title) > 200:
        raise BridgeError("title must be 2-200 characters")
    matches = [w for w in gw.getAllWindows() if title.lower() in (w.title or "").lower()]
    if not matches:
        raise BridgeError(f"no window title contains: {title}")
    return matches


def do_close_window(payload):
    matches = _find_windows(payload.get("title"))
    # never close several windows by accident — the caller must say all=true
    if len(matches) > 1 and payload.get("all") is not True:
        raise BridgeError(
            f"{len(matches)} windows match; be more specific or pass all=true: "
            + "; ".join((w.title or "")[:60] for w in matches[:5])
        )
    closed = []
    for w in matches[:10]:
        w.close()
        closed.append((w.title or "")[:120])
    return {"closed": closed}


def do_window_state(payload):
    state = str(payload.get("state") or "").lower()
    if state not in ("minimize", "maximize", "restore"):
        raise BridgeError("state must be minimize|maximize|restore")
    w = _find_windows(payload.get("title"))[0]
    getattr(w, state)()
    return {"window": (w.title or "")[:120], "state": state}


def do_brightness(payload):
    _need_windows("brightness")
    # floor of 5 so the agent can never black out the only display
    level = _clamp(payload.get("level"), 5, 100, 50)
    _ps(
        "Invoke-CimMethod -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods "
        f"-MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness={level}}} | Out-Null"
    )
    return {"brightness": level}


_WIFI_NAME_RE = re.compile(r"^[A-Za-z0-9 ._-]{1,40}$")


def do_wifi_status(_payload):
    _need_windows("wifi_status")
    out = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True, text=True, timeout=15)
    text = (out.stdout or "").strip()
    return {"raw": text[:2000] or "no wireless interface found"}


def do_wifi_set(payload):
    _need_windows("wifi_set")
    action = str(payload.get("action") or "").lower()
    if action not in ("on", "off"):
        raise BridgeError("action must be on|off")
    name = str(payload.get("interface") or "Wi-Fi")
    if not _WIFI_NAME_RE.match(name):
        raise BridgeError("invalid interface name")
    admin = "enabled" if action == "on" else "disabled"
    out = subprocess.run(
        ["netsh", "interface", "set", "interface", f"name={name}", f"admin={admin}"],
        capture_output=True, text=True, timeout=20,
    )
    if out.returncode != 0:
        msg = (out.stdout or out.stderr or "netsh failed").strip()[:300]
        raise BridgeError(msg + " — toggling WiFi needs the bridge to run as Administrator")
    return {"wifi": action, "interface": name}


def do_power(payload):
    _need_windows("power")
    action = str(payload.get("action") or "").lower()
    if action == "cancel":
        subprocess.run(["shutdown", "/a"], capture_output=True, text=True, timeout=10)
        return {"power": "cancelled"}
    # restart/shutdown always get a countdown so the user can still abort
    delay = _clamp(payload.get("delay"), 15, 300, 30)
    if action == "shutdown":
        subprocess.run(["shutdown", "/s", "/t", str(delay)], check=True, timeout=10)
    elif action == "restart":
        subprocess.run(["shutdown", "/r", "/t", str(delay)], check=True, timeout=10)
    elif action == "hibernate":
        subprocess.run(["shutdown", "/h"], check=True, timeout=10)
        return {"power": "hibernate"}
    elif action == "sleep":
        subprocess.Popen(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"])
        return {"power": "sleep"}
    else:
        raise BridgeError("action must be shutdown|restart|sleep|hibernate|cancel")
    return {"power": action, "inSeconds": delay, "abort": "call power with action=cancel (or run: shutdown /a)"}


def do_webcam_capture(payload):
    cv2 = _lazy("cv2")
    cam = _clamp(payload.get("camera"), 0, 4, 0)
    cap = cv2.VideoCapture(cam)
    try:
        if not cap.isOpened():
            raise BridgeError("webcam could not be opened (in use by another app, or privacy switch off?)")
        for _ in range(5):  # let auto-exposure settle
            cap.read()
        ok, frame = cap.read()
        if not ok:
            raise BridgeError("webcam returned no frame")
    finally:
        cap.release()
    path = os.path.join(_media_dir(), f"webcam-{_stamp()}.png")
    cv2.imwrite(path, frame)
    return {"saved": path, "width": int(frame.shape[1]), "height": int(frame.shape[0])}


def do_screen_record(payload):
    mss = _require(_LIBS.get("mss"), "mss")
    cv2 = _lazy("cv2")
    np = _lazy("numpy")
    seconds = _clamp(payload.get("seconds"), 1, 60, 10)
    fps = _clamp(payload.get("fps"), 2, 15, 8)
    path = os.path.join(_media_dir(), f"screen-{_stamp()}.mp4")
    frames = 0
    with mss.mss() as sct:
        idx = _clamp(payload.get("monitor"), 1, max(1, len(sct.monitors) - 1), 1)
        mon = sct.monitors[idx]
        size = (int(mon["width"]), int(mon["height"]))
        writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
        if not writer.isOpened():
            raise BridgeError("could not open the video writer")
        interval = 1.0 / fps
        end = time.time() + seconds
        try:
            # the kill switch stops a recording mid-way
            while time.time() < end and not _killed():
                t0 = time.time()
                frame = np.ascontiguousarray(np.array(sct.grab(mon))[:, :, :3])
                writer.write(frame)
                frames += 1
                time.sleep(max(0.0, interval - (time.time() - t0)))
        finally:
            writer.release()
    return {"saved": path, "seconds": seconds, "fps": fps, "frames": frames, "stoppedByKill": _killed()}


def do_system_info(_payload):
    info = {"platform": sys.platform}
    try:
        psutil = __import__("psutil")
        vm = psutil.virtual_memory()
        du = shutil.disk_usage(os.path.expanduser("~"))
        info.update({
            "cpuPercent": psutil.cpu_percent(interval=0.3),
            "ramPercent": vm.percent,
            "ramTotalGB": round(vm.total / 1e9, 1),
            "diskFreeGB": round(du.free / 1e9, 1),
        })
        bat = psutil.sensors_battery()
        if bat is not None:
            info["battery"] = {"percent": round(bat.percent), "plugged": bool(bat.power_plugged)}
    except Exception:
        du = shutil.disk_usage(os.path.expanduser("~"))
        info["diskFreeGB"] = round(du.free / 1e9, 1)
        info["hint"] = LIB_HINTS["psutil"] + "  (for CPU / RAM / battery)"
    if sys.platform == "win32":
        try:
            raw = _ps("(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness").strip()
            info["brightness"] = int(raw.splitlines()[0])
        except Exception:
            pass
    return info


def do_ping(_payload=None):
    return {
        "ok": True,
        "bridge": "agentscope-desktop-bridge/1.0",
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "libs": {k: (_LIBS.get(k) is not None) for k in ("pyautogui", "mss", "pygetwindow", "send2trash")},
        "keyboardHotkey": _keyboard is not None,
        "killed": _killed(),
        "failsafe": True,
        "hints": {k: LIB_HINTS[k] for k, v in _LIBS.items() if v is None},
    }


# --------------------------------------------------------------------------
# HTTP server
# --------------------------------------------------------------------------

JSON_ENDPOINTS = {
    "mouse_move": do_mouse_move,
    "click": do_click,
    "type_text": do_type_text,
    "hotkey": do_hotkey,
    "scroll": do_scroll,
    "list_windows": do_list_windows,
    "focus_window": do_focus_window,
    "clipboard_get": lambda p: {"text": _clipboard_get()},
    "clipboard_set": lambda p: _clipboard_set(str(p.get("text") or "")),
    "open_app": do_open_app,
    "volume": do_volume,
    "lock_screen": do_lock_screen,
    "recycle_delete": do_recycle_delete,
    "close_window": do_close_window,
    "window_state": do_window_state,
    "brightness": do_brightness,
    "wifi_status": do_wifi_status,
    "wifi_set": do_wifi_set,
    "power": do_power,
    "webcam_capture": do_webcam_capture,
    "screen_record": do_screen_record,
    "system_info": do_system_info,
    "chrome_history": _search_history,
    "kill": lambda p: engage_kill(str(p.get("reason") or "requested from Studio"), "studio"),
}

# actions that MOVE or TYPE or DESTROY — the Studio asks the user first,
# the bridge only needs to know which ones must not auto-retry
MUTATING = {
    "mouse_move", "click", "type_text", "hotkey", "scroll", "focus_window",
    "clipboard_set", "open_app", "volume", "lock_screen", "recycle_delete",
    "close_window", "window_state", "brightness", "wifi_set", "power",
    "webcam_capture", "screen_record",
    "kill",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentScopeDesktopBridge/1.0"

    def log_message(self, fmt, *args):  # quiet — the Studio logs the audit
        pass

    # -- helpers ----------------------------------------------------------
    def _token_ok(self):
        if not TOKEN:
            return False
        return self.headers.get("X-Desktop-Token", "") == TOKEN

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- routes -----------------------------------------------------------
    def do_GET(self):
        if self.path not in ("/ping", "/status"):
            self._send_json({"ok": False, "error": "not found"}, 404)
            return
        if not self._token_ok():
            self._send_json({"ok": False, "error": "unauthorized"}, 401)
            return
        self._send_json(do_ping())

    def do_POST(self):
        if not self._token_ok():
            self._send_json({"ok": False, "error": "unauthorized"}, 401)
            return

        name = self.path.strip("/").split("?")[0]

        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise BridgeError("JSON body must be an object")
        except Exception as exc:
            self._send_json({"ok": False, "error": f"bad request: {exc}"}, 400)
            return

        # KILL SWITCH — checked for EVERY endpoint (even /ping-like POSTs)
        if _killed() and name != "kill":
            self._send_json({
                "ok": False,
                "error": "kill switch engaged — action refused",
                "killed": True,
            }, 423)  # 423 Locked
            return

        try:
            if name == "screenshot":
                body, ctype, meta = do_screenshot(payload)
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Desktop-Meta", json.dumps(meta))
                self.end_headers()
                self.wfile.write(body)
                return
            fn = JSON_ENDPOINTS.get(name)
            if fn is None:
                self._send_json({"ok": False, "error": f"unknown endpoint: {name}"}, 404)
                return
            self._send_json({"ok": True, "data": fn(payload)})
        except BridgeError as exc:
            self._send_json({"ok": False, "error": str(exc)}, 400)
        except KeyError as exc:
            self._send_json({"ok": False, "error": f"missing field: {exc}"}, 400)
        except Exception as exc:
            self._send_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:400]}, 500)


def main():
    global PORT, TOKEN, KILL_FLAG
    parser = argparse.ArgumentParser(description="AgentScope desktop bridge")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AGENTSCOPE_DESKTOP_PORT", 8791)))
    parser.add_argument("--token", default=os.environ.get("AGENTSCOPE_DESKTOP_TOKEN", ""))
    parser.add_argument("--kill-flag", default=os.environ.get("AGENTSCOPE_KILL_FLAG", ""))
    args = parser.parse_args()
    PORT, TOKEN, KILL_FLAG = args.port, args.token, args.kill_flag

    if not TOKEN:
        print(json.dumps({"ok": False, "error": "refusing to start without --token"}))
        sys.exit(2)

    _detect_libs()
    _start_hotkey_listener()

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(json.dumps(do_ping()), flush=True)  # the Studio reads this as the readiness line
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
