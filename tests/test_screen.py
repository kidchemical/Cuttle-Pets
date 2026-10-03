"""Screensaver/lock suspend: probe parsing, suspend logic, and server wiring."""

import threading
import unittest

from server import screen, server


def ok(stdout):
    return screen.CompletedLike(0, stdout)


def failing():
    return screen.CompletedLike(1, "")


class ProbeTests(unittest.TestCase):
    def test_gnome_active(self):
        self.assertTrue(screen.probe_gnome_screensaver(run=lambda *a, **k: ok("(true,)")))
        self.assertFalse(screen.probe_gnome_screensaver(run=lambda *a, **k: ok("(false,)")))

    def test_gnome_unavailable(self):
        self.assertIsNone(screen.probe_gnome_screensaver(run=lambda *a, **k: failing()))
        self.assertIsNone(screen.probe_gnome_screensaver(run=lambda *a, **k: None))
        self.assertIsNone(screen.probe_gnome_screensaver(run=lambda *a, **k: ok("garbage")))

    def test_freedesktop_active(self):
        self.assertTrue(screen.probe_freedesktop_screensaver(run=lambda *a, **k: ok("(true,)")))
        self.assertFalse(screen.probe_freedesktop_screensaver(run=lambda *a, **k: ok("(false,)")))
        self.assertIsNone(screen.probe_freedesktop_screensaver(run=lambda *a, **k: failing()))

    def test_xscreensaver_blanked(self):
        blanked = "screen blanked since Wed Oct  1 12:00:00 2025\n"
        idle = "screen non-blanked since Wed Oct  1 12:00:00 2025\n"
        self.assertTrue(screen.probe_xscreensaver(run=lambda *a, **k: ok(blanked)))
        self.assertFalse(screen.probe_xscreensaver(run=lambda *a, **k: ok(idle)))
        self.assertIsNone(screen.probe_xscreensaver(run=lambda *a, **k: failing()))

    def test_logind_locked(self):
        real_sid = screen._own_session_id
        screen._own_session_id = lambda: "3"
        try:
            self.assertTrue(screen.probe_logind_locked(run=lambda *a, **k: ok("yes\n")))
            self.assertFalse(screen.probe_logind_locked(run=lambda *a, **k: ok("no\n")))
            self.assertIsNone(screen.probe_logind_locked(run=lambda *a, **k: failing()))
        finally:
            screen._own_session_id = real_sid

    def test_logind_no_session_means_unknown(self):
        real_sid = screen._own_session_id
        screen._own_session_id = lambda: None
        try:
            self.assertIsNone(screen.probe_logind_locked(run=lambda *a, **k: ok("yes\n")))
        finally:
            screen._own_session_id = real_sid


class SuspendLogicTests(unittest.TestCase):
    def test_any_probe_true_suspends(self):
        calls = []

        def run(cmd, **kwargs):
            calls.append(cmd[1] if len(cmd) > 1 else cmd[0])
            if cmd[0] == "xscreensaver-command":
                return ok("screen blanked since ...\n")
            return failing()

        self.assertTrue(screen.is_suspended(run))

    def test_all_false_or_unknown_resumes(self):
        def run(cmd, **kwargs):
            if cmd[0] == "xscreensaver-command":
                return ok("screen non-blanked since ...\n")
            return failing()  # gdbus/logind missing -> unknown, must not block resume

        self.assertFalse(screen.is_suspended(run))

    def test_all_unknown_resumes(self):
        self.assertFalse(screen.is_suspended(run=lambda *a, **k: failing()))

    def test_probe_exception_does_not_raise(self):
        def boom(cmd, **kwargs):
            raise RuntimeError("nope")

        self.assertFalse(screen.is_suspended(run=boom))


class WatchTests(unittest.TestCase):
    def test_reports_transitions_only(self):
        states = [False, False, True, True, False]
        seen = []
        it = iter(states)
        stop = threading.Event()

        def run(cmd, **kwargs):
            return failing()

        real_is_suspended = screen.is_suspended
        screen.is_suspended = lambda run=None: next(it, False)
        try:
            t = threading.Thread(
                target=screen.watch,
                kwargs={"on_change": seen.append, "poll_interval": 0.01,
                        "run": run, "stop": stop},
                daemon=True,
            )
            t.start()
            t.join(timeout=5)
            stop.set()
            t.join(timeout=5)
        finally:
            screen.is_suspended = real_is_suspended
        self.assertEqual(seen, [False, True, False])


class ServerWiringTests(unittest.TestCase):
    def setUp(self):
        server.app.config["TESTING"] = True
        self.client = server.app.test_client()
        with server._screen_lock:
            server._screen_suspended = False

    def tearDown(self):
        with server._screen_lock:
            server._screen_suspended = False

    def test_screen_endpoint(self):
        resp = self.client.get("/screen")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json(), {"ok": True, "suspended": False})

    def test_change_broadcasts_once_per_transition(self):
        import queue

        q = queue.Queue()
        with server._sub_lock:
            server._subscribers.append(q)
        try:
            import json

            server._on_screen_change(False)  # no transition -> silent
            self.assertTrue(q.empty())
            server._on_screen_change(True)
            self.assertEqual(json.loads(q.get_nowait()), {"suspended": True})
            server._on_screen_change(True)  # repeat -> silent
            self.assertTrue(q.empty())
            server._on_screen_change(False)
            self.assertEqual(json.loads(q.get_nowait()), {"suspended": False})
        finally:
            with server._sub_lock:
                if q in server._subscribers:
                    server._subscribers.remove(q)

    def test_events_stream_includes_suspended_snapshot(self):
        with server._screen_lock:
            server._screen_suspended = True
        try:
            resp = self.client.get("/events", buffered=False)
            head = b""
            for chunk in resp.response:
                head += chunk if isinstance(chunk, bytes) else chunk.encode()
                if b'"suspended": true' in head:
                    break
                if len(head) > 4096:
                    break
            self.assertIn(b'"suspended": true', head)
        finally:
            with server._screen_lock:
                server._screen_suspended = False


if __name__ == "__main__":
    unittest.main()
