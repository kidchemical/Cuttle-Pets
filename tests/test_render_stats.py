import unittest

from server import server


class RenderStatsTest(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        server._render_stats.clear()

    def test_empty_before_first_report(self):
        body = self.client.get("/render-stats").get_json()
        self.assertEqual(body, {"ok": True, "stats": {}, "ageSeconds": None})

    def test_latest_report_replaces_previous_and_keeps_scalars_only(self):
        self.client.post("/render-stats", json={"fps": 30, "stale": 1})
        self.client.post("/render-stats", json={
            "fps": 59.9, "width": 1344, "preset": "ultra", "ok": True,
            "nested": {"x": 1}, "list": [1], "long": "x" * 65, "k" * 33: 1,
        })
        body = self.client.get("/render-stats").get_json()
        self.assertEqual(body["stats"], {"fps": 59.9, "width": 1344, "preset": "ultra", "ok": True})
        self.assertGreaterEqual(body["ageSeconds"], 0)


if __name__ == "__main__":
    unittest.main()
