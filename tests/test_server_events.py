import unittest
from server import server


class PetEventTests(unittest.TestCase):
    def setUp(self):
        server.app.config["TESTING"] = True
        self.client = server.app.test_client()

    def post_event(self, state, **extra):
        body = {"state": state}
        body.update(extra)
        resp = self.client.post("/pet/event", json=body)
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        return resp.get_json()["payload"]

    def test_thinking_sets_working_without_arm_action(self):
        payload = self.post_event("thinking")
        self.assertTrue(payload["working"])
        self.assertNotIn("playAction", payload)

    def test_streaming_sets_working_without_arm_action(self):
        payload = self.post_event("streaming")
        self.assertTrue(payload["working"])
        self.assertNotIn("playAction", payload)

    def test_done_clears_working(self):
        payload = self.post_event("done")
        self.assertFalse(payload["working"])
        self.assertEqual(payload["playAction"], "happy")

    def test_idle_clears_working(self):
        payload = self.post_event("idle")
        self.assertFalse(payload["working"])

    def test_explicit_working_override(self):
        payload = self.post_event("idle", working=True)
        self.assertTrue(payload["working"])

    def test_action_accepts_new_animation_presets(self):
        for name in ("waving", "cheering", "sittingIdle", "sittingTalk",
                     "breakdance", "talkingIdle", "phoneCall"):
            resp = self.client.post("/action", json={"action": name})
            self.assertEqual(resp.status_code, 200, name)
            self.assertTrue(resp.get_json()["ok"], name)

    def test_action_rejects_unknown(self):
        resp = self.client.post("/action", json={"action": "moonwalk"})
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
