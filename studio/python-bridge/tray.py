# tray.py — AgentScope Jarvis system tray (Jarvis #6).
#
# Laptop on hote hi Jarvis ready — bina terminal kholne ke. Ye script:
#   - system tray icon dikhata hai (pystray + PIL):
#       HARÁ    = Studio chal raha hai, sab normal
#       PEELA   = Studio band / reachable nahi (dheere-dheere blink)
#       LAAL    = KILL SWITCH engaged
#       SLATE   = "Pause Jarvis" on (mic + wake word paused)
#   - right-click menu:
#       Open Studio        → default browser me http://127.0.0.1:3000
#       Mute mic           → db/.mic-muted flag (voice bridge wake word
#                            turant pause — recording kabhi nahi hoti)
#       Pause Jarvis       → db/.jarvis-paused flag (wake + proactive)
#       Kill switch        → .agentic-workspace/kill-flag.json (SAME file the
#                            Studio's safety.ts likhta hai — poora Jarvis band)
#       Resume             → kill flag hatao (wahi shape jo safety.ts likhta hai)
#   - crash recovery: icon crash ho jaye to supervisor 5 baar tak wapas
#     uthata hai.
#
# Flags ka faida: tray ko Studio se koi HTTP contract nahi chahiye — bas
# chhoti files. Studio/bridges wahi files har action se pehle check karte
# hain (voice_bridge._user_paused / desktop_bridge kill check).
#
# Install (Windows):
#   pip install pystray pillow
#   python python-bridge/tray.py --studio-root "C:\path\to\agentscope-suite\studio"
# Ya simply: scripts\windows\install-studio.ps1 -WithTray

import argparse
import json
import os
import sys
import time
import threading
import urllib.request

# ---------------------------------------------------------------------------
# paths + state
# ---------------------------------------------------------------------------
STUDIO_ROOT = os.getcwd()
STUDIO_URL = "http://127.0.0.1:3000"
KILL_FLAG = ""
MUTE_FLAG = ""
PAUSE_FLAG = ""

# shared status read by the icon renderer
STATUS = {"color": "amber", "label": "starting…"}
LOCK = threading.Lock()

COLORS = {
    "green": (16, 185, 129, 255),    # emerald
    "yellow": (245, 190, 40, 255),   # amber
    "red": (239, 68, 68, 255),       # rose
    "slate": (113, 113, 122, 255),   # zinc-500
}


def make_icon_image(color):
    """A small filled circle with a dark ring — no asset files needed."""
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([2, 2, size - 2, size - 2], fill=COLORS[color])
    draw.ellipse([8, 8, size - 8, size - 8], outline=(9, 9, 11, 255), width=6)
    return img


def flag_exists(path):
    try:
        return bool(path) and os.path.exists(path)
    except Exception:
        return False


def write_kill(reason="tray kill switch"):
    """EXACTLY the shape src/lib/agentic/safety.ts reads."""
    state = {
        "killed": True,
        "reason": reason[:300],
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "tray",
    }
    try:
        os.makedirs(os.path.dirname(KILL_FLAG), exist_ok=True)
        with open(KILL_FLAG, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def release_kill():
    """safety.ts releaseKill(): killed:false likhta hai, file delete nahi."""
    state = {
        "killed": False,
        "reason": "",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "tray",
    }
    try:
        os.makedirs(os.path.dirname(KILL_FLAG), exist_ok=True)
        with open(KILL_FLAG, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def toggle_flag(path, on_label):
    if flag_exists(path):
        try:
            os.remove(path)
        except Exception:
            pass
        return f"{on_label} OFF"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    except Exception:
        pass
    return f"{on_label} ON"


# ---------------------------------------------------------------------------
# status poller (background thread)
# ---------------------------------------------------------------------------
def poll_status():
    """Studio ka /api/health + flag files → icon color."""
    while True:
        killed = flag_exists(KILL_FLAG)
        paused = flag_exists(PAUSE_FLAG) or flag_exists(MUTE_FLAG)
        studio_up = False
        try:
            with urllib.request.urlopen(f"{STUDIO_URL}/api/health", timeout=4) as r:
                studio_up = r.status == 200
        except Exception:
            studio_up = False

        if killed:
            color, label = "red", "KILL SWITCH engaged"
        elif paused:
            color, label = "slate", "Paused / muted"
        elif studio_up:
            color, label = "green", "Jarvis ready"
        else:
            color, label = "yellow", "Studio offline"
        with LOCK:
            STATUS["color"] = color
            STATUS["label"] = label
        time.sleep(5)


def current_color():
    with LOCK:
        return STATUS["color"], STATUS["label"]


# ---------------------------------------------------------------------------
# tray icon
# ---------------------------------------------------------------------------
def run_tray():
    import pystray

    def open_studio(icon, item):
        import webbrowser
        webbrowser.open(STUDIO_URL)

    def toggle_mute(icon, item):
        toggle_flag(MUTE_FLAG, "Mic mute")

    def toggle_pause(icon, item):
        toggle_flag(PAUSE_FLAG, "Pause Jarvis")

    def kill_now(icon, item):
        write_kill()

    def resume(icon, item):
        release_kill()

    def quit_tray(icon, item):
        icon.stop()
        os._exit(0)

    menu = pystray.Menu(
        pystray.MenuItem("Open Studio", open_studio, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(lambda item: f"Mute mic {'✓' if flag_exists(MUTE_FLAG) else ''}", toggle_mute),
        pystray.MenuItem(lambda item: f"Pause Jarvis {'✓' if flag_exists(PAUSE_FLAG) else ''}", toggle_pause),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Kill switch (sab band)", kill_now),
        pystray.MenuItem("Resume (kill hatao)", resume),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit tray", quit_tray),
    )

    icon = pystray.Icon(
        "agentscope-jarvis",
        make_icon_image("amber"),
        "AgentScope Jarvis — starting…",
        menu,
    )

    # the icon image must track the polled status
    def icon_refresher():
        last = ""
        while True:
            color, label = current_color()
            if color != last:
                last = color
                try:
                    icon.icon = make_icon_image(color)
                    icon.title = f"AgentScope Jarvis — {label}"
                except Exception:
                    pass
            time.sleep(2)

    threading.Thread(target=poll_status, daemon=True).start()
    threading.Thread(target=icon_refresher, daemon=True).start()
    icon.run()


def main():
    global STUDIO_ROOT, STUDIO_URL, KILL_FLAG, MUTE_FLAG, PAUSE_FLAG
    parser = argparse.ArgumentParser(description="AgentScope Jarvis tray icon")
    parser.add_argument("--studio-root", default=os.getcwd(),
                        help="the studio folder (flags are resolved relative to it)")
    parser.add_argument("--port", type=int,
                        default=int(os.environ.get("PORT", 3000)))
    args = parser.parse_args()

    STUDIO_ROOT = os.path.abspath(args.studio_root)
    STUDIO_URL = f"http://127.0.0.1:{args.port}"
    KILL_FLAG = os.path.join(STUDIO_ROOT, ".agentic-workspace", "kill-flag.json")
    MUTE_FLAG = os.path.join(STUDIO_ROOT, "db", ".mic-muted")
    PAUSE_FLAG = os.path.join(STUDIO_ROOT, "db", ".jarvis-paused")

    # crash recovery: agar icon crash ho jaye to 5 baar tak wapas uthao
    attempts = 0
    while attempts < 5:
        attempts += 1
        try:
            run_tray()
            break  # clean exit (user ne Exit dabaya)
        except KeyboardInterrupt:
            break
        except Exception as exc:
            print(f"[tray] crashed ({exc}); restart #{attempts} in 5s", file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    main()
