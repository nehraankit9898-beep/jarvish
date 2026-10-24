# voice_bridge.py — AgentScope voice bridge (Jarvis #3 TTS + #1 wake word).
#
# A SMALL always-available HTTP server (127.0.0.1 only, token auth) that:
#   1. Speaks: POST /tts  {text, voice?, rate?}  -> audio/mpeg bytes
#      (edge-tts — free Microsoft neural voices, hi-IN + en-IN, needs internet)
#   2. Listens for the wake word "Hey Jarvis" (openWakeWord, offline, CPU-light)
#      or Porcupine ("jarvis" keyword, optional, needs an access key).
#      While listening it NEVER records or stores audio — frames go straight
#      into the model and are dropped.
#
# The Studio (Node) spawns this bridge the same way as desktop_bridge.py and
# polls /wake/status via /api/voice/wake. When the wake word fires, Studio
# opens the mic session (browser speech recognition) — "hands-free".
#
# Safety / privacy:
#   - binds to 127.0.0.1 only; every request needs X-Desktop-Token
#   - the kill flag file (same one the desktop bridge uses) stops everything
#   - db/.mic-muted  (written by the tray "Mute mic") pauses wake listening
#   - db/.jarvis-paused (tray "Pause Jarvis") pauses wake listening too
#   - audio frames are processed in-memory and discarded; nothing is written
#
# Install (Windows):
#   pip install -r python-bridge/requirements-voice.txt
# First wake-word run downloads the "hey_jarvis" model (~2 MB) — after that
# it is fully offline.

import argparse
import asyncio
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# config (argv > env > defaults) — set in main() before the threads start
# ---------------------------------------------------------------------------
PORT = 8792
TOKEN = ""
KILL_FLAG = ""
STATE_DIR = ""
TTS_VOICE_DEFAULT = os.environ.get("AGENTSCOPE_TTS_VOICE", "hi-IN-MadhurNeural")
WAKE_SENSITIVITY = float(os.environ.get("AGENTSCOPE_WAKE_SENSITIVITY", "0.5"))
WAKE_MODEL_DIR = os.environ.get("AGENTSCOPE_WAKE_MODEL_DIR", "")

# sample rate / frame length expected by openWakeWord
SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280          # 80 ms
REFRACTORY_SEC = 5.0          # one trigger per 5 s max

# ---------------------------------------------------------------------------
# shared state (guarded by a lock; handlers run on many threads)
# ---------------------------------------------------------------------------
STATE = {
    "tts_busy": False,
    "tts_last_error": "",
    "wake": {
        "requested": False,       # the Studio asked for listening
        "listening": False,       # capture loop actually running
        "paused": False,          # mute/pause flags or explicit pause
        "engine": "none",         # none | openwakeword | porcupine
        "engine_detail": "",
        "sensitivity": WAKE_SENSITIVITY,
        "last_trigger_at": 0.0,   # unix seconds
        "triggers": 0,
        "started_at": 0.0,
        "error": "",
    },
}
LOCK = threading.Lock()


def _killed():
    """The global kill switch (same flag file as the desktop bridge)."""
    if not KILL_FLAG:
        return False
    try:
        return os.path.exists(KILL_FLAG)
    except Exception:
        return False


def _flag_file(name):
    return os.path.join(STATE_DIR, name) if STATE_DIR else ""


def _user_paused():
    """Tray 'Mute mic' / 'Pause Jarvis' flags."""
    for name in (".mic-muted", ".jarvis-paused"):
        f = _flag_file(name)
        try:
            if f and os.path.exists(f):
                return True
        except Exception:
            pass
    return False


def _sensitivity_to_threshold(sensitivity):
    """sensitivity 0..1 -> score threshold 0.7..0.3 (0.5 default)."""
    try:
        s = min(1.0, max(0.0, float(sensitivity)))
    except Exception:
        s = 0.5
    return round(0.7 - 0.4 * s, 3)


# ---------------------------------------------------------------------------
# TTS (edge-tts)
# ---------------------------------------------------------------------------

_TTS_VOICES = {
    "hindi": "hi-IN-MadhurNeural",
    "hindi-female": "hi-IN-SwaraNeural",
    "english-in": "en-IN-NeerjaNeural",
    "english": "en-US-GuyNeural",
    "default": TTS_VOICE_DEFAULT,
}

_CODE_BLOCK = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_INLINE_CODE = re.compile(r"`([^`]+)`")
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_MD_NOISE = re.compile(r"[#*_>|]+")


def speech_friendly(text, max_chars=3000):
    """Long answers ko bolne layak chhota karo — code/tables bolna nahi."""
    t = str(text or "")
    t = _CODE_BLOCK.sub(" (code block) ", t)
    t = _INLINE_CODE.sub(r"\1", t)
    t = _MD_LINK.sub(r"\1", t)
    t = _MD_NOISE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # table rows are unreadable aloud — cut at the first pipe-heavy line
    if "|" in t:
        t = t.split(" | ")[0]
    return t[:max_chars]


def _resolve_voice(name):
    if not name:
        return _TTS_VOICES["default"]
    key = str(name).strip().lower()
    if key in _TTS_VOICES:
        return _TTS_VOICES[key]
    if re.match(r"^[a-z]{2}-[A-Z]{2}-\w+Neural$", str(name)):
        return str(name)          # a full edge-tts voice name
    return _TTS_VOICES["default"]


def _tts_sync(text, voice, rate):
    """Synthesise to MP3 bytes. Runs edge-tts's asyncio loop on this thread."""
    import edge_tts  # lazy import — the bridge must start without it too

    async def _run():
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        return buf.getvalue()

    try:
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            return loop.run_until_complete(_run())
        finally:
            try:
                loop.close()
            except Exception:
                pass
    except Exception as exc:
        with LOCK:
            STATE["tts_last_error"] = str(exc)[:300]
        raise


def do_tts(payload):
    text = speech_friendly(payload.get("text", ""))
    if not text:
        raise BridgeError("text is required")
    voice = _resolve_voice(payload.get("voice"))
    rate = str(payload.get("rate") or "+0%")
    if not re.match(r"^[+-]\d+%$", rate):
        rate = "+0%"
    data = _tts_sync(text, voice, rate)
    return data, "audio/mpeg"


def do_tts_voices(_payload):
    return {
        "ok": True,
        "data": {
            "default": _TTS_VOICES["default"],
            "options": [
                {"id": "hindi", "label": "Hindi (Madhur)"},
                {"id": "hindi-female", "label": "Hindi (Swara)"},
                {"id": "english-in", "label": "English India (Neerja)"},
                {"id": "english", "label": "English US (Guy)"},
            ],
        },
    }


# ---------------------------------------------------------------------------
# Wake word engine
# ---------------------------------------------------------------------------

def _detect_wake_engine():
    """Which engine can we actually use?"""
    try:
        import openwakeword  # noqa: F401
        return "openwakeword", ""
    except Exception as exc:
        detail = str(exc)[:120]
    try:
        import pvporcupine  # noqa: F401
        return "porcupine", ""
    except Exception:
        pass
    return "none", detail


def _find_hey_jarvis_model():
    """Locate a hey_jarvis model file for the installed openwakeword version.

    openwakeword 0.4.x SHIPS the models in the wheel (resources/models/),
    while 0.5/0.6 download them on first use. The old code only knew the
    download path — on 0.4.x it crashed with "cannot import name
    'download_models'" and the wake word never started.
    """
    candidates = []
    if WAKE_MODEL_DIR:
        for name in ("hey_jarvis_v0.1.onnx", "hey_jarvis.onnx", "hey_jarvis_v0.1.tflite"):
            candidates.append(os.path.join(WAKE_MODEL_DIR, name))
    try:
        import openwakeword
        res = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
        if os.path.isdir(res):
            for name in sorted(os.listdir(res)):
                if "hey_jarvis" in name and name.endswith(".onnx"):
                    candidates.append(os.path.join(res, name))
    except Exception:
        pass
    for p in candidates:
        try:
            if p and os.path.exists(p):
                return p
        except Exception:
            continue
    return ""


def _ensure_oww_model():
    """Return a model reference (path or name) for openWakeWord.

    Downloads ONLY when the wheel ships no model and none is in the model dir
    (openwakeword 0.5/0.6 first-run behaviour — needs internet once).
    """
    found = _find_hey_jarvis_model()
    if found:
        if WAKE_MODEL_DIR:
            # openwakeword honours this env var for its model directory
            os.environ["OPENWAKEWORD_MODEL_DIR"] = WAKE_MODEL_DIR
            os.makedirs(WAKE_MODEL_DIR, exist_ok=True)
        return found
    # 0.5/0.6: first run downloads the "hey_jarvis" model (~2 MB)
    try:
        from openwakeword.utils import download_models
    except ImportError:
        return "hey_jarvis"  # name-based resolution is all we can offer
    try:
        download_models(model_names=["hey_jarvis"])
    except TypeError:
        download_models()  # older openwakeword: download everything small
    found = _find_hey_jarvis_model()
    return found or "hey_jarvis"


def _wake_loop():
    """The mic capture + scoring loop. Runs on its own daemon thread."""
    import numpy as np  # openwakeword dependency anyway

    with LOCK:
        engine = STATE["wake"]["engine"]

    model = None
    porcupine = None
    stream = None

    try:
        import sounddevice as sd

        if engine == "openwakeword":
            from openwakeword.model import Model
            model_ref = _ensure_oww_model()
            # 0.5/0.6 take model NAMES/paths via `wakeword_models`;
            # 0.4.x takes file paths via `wakeword_model_paths` (unknown
            # kwargs are silently swallowed there — an empty model list made
            # every prediction score 0 and the wake word never fired).
            import inspect as _inspect
            params = _inspect.signature(Model.__init__).parameters
            if "wakeword_models" in params:
                model = Model(
                    wakeword_models=[model_ref],
                    inference_framework="onnx",
                )
            else:
                model = Model(wakeword_model_paths=[model_ref])
            keyword = "hey_jarvis"
        else:
            import pvporcupine
            access_key = os.environ.get("AGENTSCOPE_PORCUPINE_KEY", "").strip()
            if not access_key:
                raise BridgeError("Porcupine needs AGENTSCOPE_PORCUPINE_KEY")
            porcupine = pvporcupine.create(
                access_key=access_key, keywords=["jarvis"]
            )
            keyword = "jarvis"
            if porcupine.frame_length != FRAME_SAMPLES:
                # porcupine uses its own frame length (usually 512)
                pass

        frame_len = porcupine.frame_length if porcupine else FRAME_SAMPLES

        def _audio_callback(indata, _frames, _time, _status):
            # audio never leaves this function — straight into the queue
            _audio_callback.buf.append(bytes(indata))

        _audio_callback.buf = deque_compat()

        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=frame_len,
            callback=_audio_callback,
        )
        stream.start()

        with LOCK:
            STATE["wake"].update(
                listening=True, started_at=time.time(), error=""
            )

        threshold = _sensitivity_to_threshold(STATE["wake"]["sensitivity"])
        last_score_log = 0.0

        while True:
            with LOCK:
                w = STATE["wake"]
                still = (
                    w["requested"]
                    and not _killed()
                    and not _user_paused()
                    and not w["paused"]
                )
                threshold = _sensitivity_to_threshold(w["sensitivity"])
            if not still:
                time.sleep(0.2)
                continue

            buf = _audio_callback.buf
            if not buf:
                time.sleep(0.02)
                continue

            frame = buf.pop(0)
            data = np.frombuffer(frame, dtype=np.int16)

            if model is not None:
                scores = model.predict(data)
                # the score key is the model file basename — "hey_jarvis" on
                # some versions, "hey_jarvis_v0.1" on others — match loosely
                score = 0.0
                for key, val in scores.items():
                    if keyword in str(key):
                        try:
                            score = float(val)
                        except (TypeError, ValueError):
                            score = 0.0
                        break
            else:
                pcm = data[: porcupine.frame_length]
                if pcm.size < porcupine.frame_length:
                    continue
                result = porcupine.process(pcm.tolist())
                score = 1.0 if result == 0 else 0.0

            now = time.time()
            if score >= threshold and (
                now - STATE["wake"]["last_trigger_at"] > REFRACTORY_SEC
            ):
                with LOCK:
                    STATE["wake"]["last_trigger_at"] = now
                    STATE["wake"]["triggers"] += 1
                # one JSON line on stdout — the Node side logs it, and the
                # poller picks the trigger up from /wake/status
                try:
                    sys.stdout.write(
                        json.dumps({"event": "wake", "score": round(score, 3)}) + "\n"
                    )
                    sys.stdout.flush()
                except Exception:
                    pass

    except Exception as exc:
        with LOCK:
            STATE["wake"]["listening"] = False
            STATE["wake"]["error"] = str(exc)[:300]
            STATE["wake"]["engine_detail"] = str(exc)[:300]
    finally:
        try:
            if stream is not None:
                stream.stop()
                stream.close()
        except Exception:
            pass
        try:
            if porcupine is not None:
                porcupine.delete()
        except Exception:
            pass
        with LOCK:
            STATE["wake"]["listening"] = False


def deque_compat():
    """A tiny thread-safe-enough FIFO: mic callback appends, loop pops."""
    return _MicFifo()


class _MicFifo(list):
    """list subclass — append from the PortAudio thread, pop(0) from ours.

    Mic frames at 80 ms arrive every ~80 ms; the loop consumes faster than
    that, so the queue stays ~1 frame deep. Bounded for safety.
    """

    def append(self, item):
        if len(self) > 16:   # ~1.3 s backlog max, then drop (stay real-time)
            self.pop(0)
        super().append(item)


def do_wake_start(payload):
    if _killed():
        raise BridgeError("KILL SWITCH is engaged — wake word refused", code=423)
    engine, detail = _detect_wake_engine()
    with LOCK:
        STATE["wake"]["engine"] = engine
        STATE["wake"]["engine_detail"] = detail
        if payload.get("sensitivity") is not None:
            try:
                STATE["wake"]["sensitivity"] = min(
                    1.0, max(0.0, float(payload["sensitivity"]))
                )
            except Exception:
                pass
        STATE["wake"]["requested"] = True
        STATE["wake"]["paused"] = False
    if engine == "none":
        return {
            "ok": False,
            "error": (
                "No wake-word engine installed. Run: "
                "pip install -r python-bridge/requirements-voice.txt "
                "(openWakeWord — free, offline). Or set AGENTSCOPE_PORCUPINE_KEY."
            ),
            "engine": "none",
        }
    # (re)start the loop thread if it is not alive
    if not (_WAKE_THREAD.is_alive()):
        _start_wake_thread()
    return {"ok": True, "engine": engine}


def do_wake_stop(_payload=None):
    with LOCK:
        STATE["wake"]["requested"] = False
    return {"ok": True}


def do_wake_pause(_payload=None):
    """Studio ke TTS ke doraan echo se bachne ke liye (spec: 'jab Jarvis bol
    raha ho tab wake word band rakho')."""
    with LOCK:
        STATE["wake"]["paused"] = True
    return {"ok": True}


def do_wake_resume(_payload=None):
    with LOCK:
        STATE["wake"]["paused"] = False
    return {"ok": True}


def do_wake_status(_payload=None):
    with LOCK:
        w = dict(STATE["wake"])
    w["muted"] = _user_paused()
    w["killed"] = _killed()
    w["threshold"] = _sensitivity_to_threshold(w["sensitivity"])
    # a trigger the Studio has not consumed yet?
    w["pending"] = (
        w["last_trigger_at"] > 0
        and w["last_trigger_at"] > _WAKE_CONSUMED["at"]
    )
    return {"ok": True, "data": w}


_WAKE_CONSUMED = {"at": 0.0}
_WAKE_THREAD = threading.Thread(target=lambda: None, daemon=True)


def _start_wake_thread():
    global _WAKE_THREAD
    _WAKE_THREAD = threading.Thread(target=_wake_loop, daemon=True, name="wake-word")
    _WAKE_THREAD.start()


# ---------------------------------------------------------------------------
# HTTP layer (same shape as desktop_bridge.py)
# ---------------------------------------------------------------------------

class BridgeError(Exception):
    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


# JSON endpoints (no raw audio)
JSON_ENDPOINTS = {
    "tts_voices": do_tts_voices,
    "wake_start": do_wake_start,
    "wake_stop": do_wake_stop,
    "wake_pause": do_wake_pause,
    "wake_resume": do_wake_resume,
    "wake_status": do_wake_status,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet — the Studio logs the audit
        return

    def _token_ok(self):
        return TOKEN and self.headers.get("X-Desktop-Token") == TOKEN

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/ping", "/status"):
            if path == "/status":
                if not self._token_ok():
                    return self._send_json({"ok": False, "error": "unauthorized"}, 401)
            with LOCK:
                wake = dict(STATE["wake"])
            payload = {
                "ok": not _killed(),
                "service": "voice-bridge",
                "port": PORT,
                "killed": _killed(),
                "tts_busy": STATE["tts_busy"],
                "wake": wake,
            }
            return self._send_json(payload)
        return self._send_json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?")[0]
        if not self._token_ok():
            return self._send_json({"ok": False, "error": "unauthorized"}, 401)
        if _killed():
            return self._send_json({"ok": False, "error": "kill switch engaged", "killed": True}, 423)

        length = min(2_000_000, int(self.headers.get("Content-Length") or 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._send_json({"ok": False, "error": "invalid JSON"}, 400)

        try:
            if path == "/tts":
                STATE["tts_busy"] = True
                try:
                    data, mime = do_tts(payload)
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-TTS-Voice", payload.get("voice") or "default")
                    self.end_headers()
                    self.wfile.write(data)
                finally:
                    STATE["tts_busy"] = False
                return

            if path == "/wake":
                op = str(payload.get("op") or "")
                if op == "start":
                    return self._send_json(do_wake_start(payload))
                if op == "stop":
                    return self._send_json(do_wake_stop())
                if op == "pause":
                    return self._send_json(do_wake_pause())
                if op == "resume":
                    return self._send_json(do_wake_resume())
                if op == "status":
                    return self._send_json(do_wake_status())
                if op == "consume":
                    # Studio acknowledges the trigger it reacted to
                    with LOCK:
                        _WAKE_CONSUMED["at"] = max(
                            _WAKE_CONSUMED["at"], STATE["wake"]["last_trigger_at"]
                        )
                    return self._send_json({"ok": True})
                return self._send_json({"ok": False, "error": f"unknown op: {op}"}, 400)

            name = path.lstrip("/").replace("-", "_").replace("/", "_")
            handler = JSON_ENDPOINTS.get(name)
            if handler:
                return self._send_json(handler(payload))
            return self._send_json({"ok": False, "error": "not found"}, 404)
        except BridgeError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, exc.code)
        except Exception as exc:
            return self._send_json({"ok": False, "error": str(exc)[:300]}, 500)


def main():
    global PORT, TOKEN, KILL_FLAG, STATE_DIR
    parser = argparse.ArgumentParser(description="AgentScope voice bridge")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AGENTSCOPE_VOICE_PORT", PORT)))
    parser.add_argument("--token", default=os.environ.get("AGENTSCOPE_DESKTOP_TOKEN", ""))
    parser.add_argument("--kill-flag", default=os.environ.get("AGENTSCOPE_KILL_FLAG", ""))
    parser.add_argument("--state-dir", default=os.getcwd())
    args = parser.parse_args()

    PORT = args.port
    TOKEN = args.token
    KILL_FLAG = args.kill_flag
    STATE_DIR = args.state_dir

    engine, detail = _detect_wake_engine()
    try:
        import edge_tts  # noqa: F401
        tts_ok = True
        tts_detail = ""
    except Exception as exc:
        tts_ok = False
        tts_detail = str(exc)[:120]

    with LOCK:
        STATE["wake"]["engine"] = engine
        STATE["wake"]["engine_detail"] = detail

    server = None
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        # BUGFIX: a stale voice_bridge.py (e.g. after a Studio crash) keeps
        # holding the port — this process used to die with a bare traceback,
        # the Studio waited the full 12 s readiness timeout and then reported
        # a confusing 401. Print one actionable JSON line instead.
        print(json.dumps({
            "ok": False,
            "service": "voice-bridge",
            "port": PORT,
            "wake_engine": "unknown",
            "tts": False,
            "tts_error": "",
            "error": (
                f"port {PORT} already in use — stop the old voice_bridge.py "
                f"process or set AGENTSCOPE_VOICE_PORT to a free port ({exc})"
            ),
        }))
        sys.stdout.flush()
        sys.exit(1)

    # one readiness JSON line on stdout — Node waits for exactly this
    print(json.dumps({
        "ok": True,
        "service": "voice-bridge",
        "port": PORT,
        "wake_engine": engine,
        "tts": tts_ok,
        "tts_error": tts_detail,
    }))
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
