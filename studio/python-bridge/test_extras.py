# Run: python python-bridge/test_extras.py   (no Windows / no extra libs needed)
# Validates the input checks of the new endpoints — the parts that must hold on every OS.
import importlib.util, os, sys, tempfile, unittest

spec = importlib.util.spec_from_file_location("bridge", os.path.join(os.path.dirname(__file__), "desktop_bridge.py"))
b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)


class Extras(unittest.TestCase):
    def test_endpoints_registered(self):
        for n in ("close_window", "window_state", "brightness", "wifi_status", "wifi_set", "power",
                  "webcam_capture", "screen_record", "system_info"):
            self.assertIn(n, b.JSON_ENDPOINTS)

    def test_mutating_set(self):
        for n in ("close_window", "window_state", "brightness", "wifi_set", "power", "webcam_capture", "screen_record"):
            self.assertIn(n, b.MUTATING)
        for n in ("wifi_status", "system_info"):
            self.assertNotIn(n, b.MUTATING)

    def test_clamp(self):
        self.assertEqual(b._clamp(999, 1, 60, 10), 60)
        self.assertEqual(b._clamp(-5, 1, 60, 10), 1)
        self.assertEqual(b._clamp("abc", 1, 60, 10), 10)
        self.assertEqual(b._clamp(None, 5, 100, 50), 50)

    def test_wifi_interface_name_validation(self):
        self.assertTrue(b._WIFI_NAME_RE.match("Wi-Fi"))
        for bad in ('Wi-Fi" & calc', "a;b", "x" * 41, "", "$(whoami)"):
            self.assertFalse(b._WIFI_NAME_RE.match(bad), bad)

    def test_power_and_wifi_refuse_non_windows(self):
        if sys.platform == "win32":
            self.skipTest("windows host")
        for fn in (b.do_power, b.do_brightness, b.do_wifi_set, b.do_wifi_status):
            with self.assertRaises(b.BridgeError):
                fn({"action": "shutdown", "level": 50})

    def test_window_title_too_short(self):
        b._LIBS = {"pygetwindow": type("G", (), {"getAllWindows": staticmethod(lambda: [])})}
        with self.assertRaises(b.BridgeError):
            b.do_close_window({"title": "a"})

    def test_close_refuses_multiple_matches(self):
        class W:
            def __init__(s, t): s.title = t; s.closed = False
            def close(s): s.closed = True
        ws = [W("Notepad - a.txt"), W("Notepad - b.txt")]
        b._LIBS = {"pygetwindow": type("G", (), {"getAllWindows": staticmethod(lambda: ws)})}
        with self.assertRaises(b.BridgeError):
            b.do_close_window({"title": "Notepad"})
        self.assertFalse(any(w.closed for w in ws))
        r = b.do_close_window({"title": "Notepad", "all": True})
        self.assertEqual(len(r["closed"]), 2)

    def test_window_state_validation(self):
        with self.assertRaises(b.BridgeError):
            b.do_window_state({"title": "Notepad", "state": "explode"})

    def test_system_info_without_psutil(self):
        info = b.do_system_info({})
        self.assertIn("diskFreeGB", info)


if __name__ == "__main__":
    unittest.main(verbosity=2)
