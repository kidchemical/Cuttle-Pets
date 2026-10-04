"""Custom reactions: catalog browsing, triggering, and normalization.

Reactions are user-defined one-shot behaviors (Settings → Behavior →
Custom reactions) that agents browse with GET /behaviors and play with
POST /behaviors/trigger.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import server


SEED = {
    "behaviorSettings": {
        "reactions": [
            {
                "id": "rocket-launch",
                "name": "Rocket launch",
                "description": "Celebrate a deploy after a git push.",
                "params": [{"name": "message", "type": "string", "default": "Shipped it!",
                            "description": "Shouted in the bubble."}],
                "steps": [
                    {"animation": "action:excited", "emotion": "happy", "durationMs": 500},
                    {"animation": "action:cheering", "emotion": "happy",
                     "say": "{{message}}", "durationMs": 500},
                ],
            },
            {
                "id": "hat-dance",
                "name": "Hat dance",
                "description": "Dance for n seconds.",
                "params": [{"name": "seconds", "type": "number", "default": 5,
                            "description": "How long to dance."}],
                "steps": [{"animation": "dance:jile", "emotion": "happy",
                           "say": "Dancing for {{seconds}}s!", "durationMs": 500}],
            },
        ]
    }
}


class ReactionEndpointTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "settings.json"
        self.path.write_text(json.dumps(SEED))
        self.settings = patch.object(server, "SETTINGS_PATH", self.path)
        self.settings.start()
        self.addCleanup(self.settings.stop)
        self.client = server.app.test_client()

    def test_catalog_lists_reactions_with_call_info(self):
        res = self.client.get("/behaviors")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertTrue(body["ok"])
        by_id = {b["id"]: b for b in body["behaviors"]}
        self.assertEqual(set(by_id), {"rocket-launch", "hat-dance"})
        rocket = by_id["rocket-launch"]
        self.assertEqual(rocket["description"], "Celebrate a deploy after a git push.")
        self.assertIn("react rocket-launch", rocket["cli"])
        self.assertEqual(rocket["http"]["path"], "/behaviors/trigger")
        self.assertEqual(rocket["http"]["body"]["id"], "rocket-launch")
        self.assertIn("message", rocket["summary"])

    def test_trigger_needs_an_id(self):
        res = self.client.post("/behaviors/trigger", json={})
        self.assertEqual(res.status_code, 400)

    def test_trigger_unknown_id_lists_known(self):
        res = self.client.post("/behaviors/trigger", json={"id": "nope"})
        self.assertEqual(res.status_code, 404)
        body = res.get_json()
        self.assertFalse(body["ok"])
        self.assertIn("rocket-launch", body["known"])

    def test_trigger_returns_rendered_steps_and_coerced_params(self):
        res = self.client.post("/behaviors/trigger",
                               json={"id": "hat-dance", "params": {"seconds": "8"}})
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["params"], {"seconds": 8})
        self.assertEqual(body["payload"]["steps"][0]["sayRendered"],
                         "Dancing for 8s!")

    def test_trigger_uses_defaults_when_no_params(self):
        res = self.client.post("/behaviors/trigger", json={"id": "rocket-launch"})
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["params"], {"message": "Shipped it!"})
        self.assertEqual(body["payload"]["steps"][1]["sayRendered"], "Shipped it!")

    def _frames(self, reaction, values, generation):
        frames = []
        with patch.object(server, "broadcast", side_effect=lambda p: frames.append(p)):
            with patch.object(server.time, "sleep", return_value=None):
                with patch.object(server, "_reaction_generation", generation):
                    server._play_reaction_sequence(reaction, values, generation=generation)
        return frames

    def test_sequence_broadcasts_reaction_steps_then_done(self):
        reactions = server._load_reactions()
        reaction = next(r for r in reactions if r["id"] == "rocket-launch")
        frames = self._frames(reaction, {"message": "Pushed!"}, 5)
        first, second, tail = frames[0], frames[1], frames[-1]
        self.assertEqual(first["reactionStep"]["animation"], "action:excited")
        self.assertEqual(first["emotion"], "happy")
        self.assertEqual((first["reactionIndex"], first["reactionCount"]), (0, 2))
        self.assertEqual(second["reactionStep"]["animation"], "action:cheering")
        self.assertEqual(second["text"], "Pushed!")
        self.assertEqual(tail, {"reactionDone": True, "reaction": "rocket-launch"})

    def test_sequence_never_forces_working_off(self):
        # The renderer restores its own working state on reactionDone; the
        # server must not clobber a pet that was already working.
        reaction = {"id": "work-bit", "name": "Work bit", "description": "",
                    "params": [],
                    "steps": [{"animation": "typing", "durationMs": 500,
                               "props": {"working": True}}]}
        frames = self._frames(reaction, {}, 7)
        self.assertEqual(frames[0]["reactionStep"]["props"], {"working": True})
        self.assertFalse(any("working" in frame for frame in frames))

    def test_superseded_sequence_sends_no_done(self):
        reactions = server._load_reactions()
        reaction = next(r for r in reactions if r["id"] == "rocket-launch")
        frames = []
        with patch.object(server, "broadcast", side_effect=lambda p: frames.append(p)):
            with patch.object(server.time, "sleep", return_value=None):
                with patch.object(server, "_reaction_generation", 2):
                    server._play_reaction_sequence(reaction, {}, generation=1)
        self.assertEqual(frames, [])

    def test_trigger_accepts_inline_draft(self):
        with patch.object(server.threading, "Thread"):
            res = self.client.post("/behaviors/trigger", json={
                "id": "draft", "reaction": {"steps": [{"animation": "action:waving", "say": "{{who}}"}],
                                            "params": [{"name": "who", "type": "string", "default": "hi"}]}})
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["payload"]["steps"][0]["sayRendered"], "hi")
        with patch.object(server.threading, "Thread"):
            bad = self.client.post("/behaviors/trigger", json={
                "id": "draft", "reaction": {"steps": [{"animation": "bogus"}]}})
        self.assertEqual(bad.status_code, 400)

    def test_dance_step_carries_animation_id(self):
        reactions = server._load_reactions()
        reaction = next(r for r in reactions if r["id"] == "hat-dance")
        frames = self._frames(reaction, {"seconds": 8}, 9)
        self.assertEqual(frames[0]["reactionStep"]["animation"], "dance:jile")
        self.assertEqual(frames[0]["text"], "Dancing for 8s!")


class ReactionNormalizationTests(unittest.TestCase):
    def test_unknown_animation_steps_are_dropped(self):
        reaction = server._normalize_reaction(
            {"id": "x", "steps": [{"animation": "bogus"}, {"animation": "idle"}]}, "x")
        self.assertIsNotNone(reaction)
        self.assertEqual([s["animation"] for s in reaction["steps"]], ["idle"])

    def test_custom_dance_without_preset_is_dropped(self):
        reaction = server._normalize_reaction({"id": "x", "steps": [
            {"animation": "dance:custom:mine"},
            {"animation": "dance:custom:mine", "preset": {"label": "Mine", "url": "/d.vmd"}},
        ]}, "x")
        self.assertEqual(len(reaction["steps"]), 1)
        self.assertEqual(reaction["steps"][0]["preset"]["url"], "/d.vmd")

    def test_step_less_reaction_is_rejected(self):
        self.assertIsNone(server._normalize_reaction({"id": "x", "steps": []}, "x"))
        self.assertIsNone(server._normalize_reaction({"id": "x"}, "x"))

    def test_duplicate_ids_deduplicated_and_capped(self):
        raw = [{"id": "same", "steps": [{"animation": "idle"}]} for _ in range(3)]
        loaded = [server._normalize_reaction(item, f"r-{i}") for i, item in enumerate(raw)]
        seen: set[str] = set()
        deduped = [r for r in loaded if r and r["id"] not in seen and not seen.add(r["id"])]
        self.assertEqual(len(deduped), 1)

    def test_param_defaults_coerce_by_type(self):
        reaction = server._normalize_reaction({
            "id": "x",
            "params": [{"name": "n", "type": "number", "default": "abc"},
                       {"name": "flag", "type": "boolean", "default": True},
                       {"name": "Bad Name!", "type": "string", "default": "hi"}],
            "steps": [{"animation": "idle"}],
        }, "x")
        by_name = {p["name"]: p for p in reaction["params"]}
        self.assertEqual(by_name["n"]["default"], 0)
        self.assertEqual(by_name["flag"]["default"], True)
        self.assertNotIn("bad name!", by_name)

    def test_template_leaves_unknown_params_alone(self):
        self.assertEqual(server._render_reaction_template("hi {{missing}}", {}), "hi {{missing}}")
        self.assertEqual(server._render_reaction_template("go {{n}}!", {"n": 3}), "go 3!")


class ReactionCliTests(unittest.TestCase):
    def test_react_posts_id_and_params(self):
        import argparse
        from cli import cuttle_pet
        args = argparse.Namespace(id="rocket-launch",
                                  param=["message=007", "n=3", "flag=true", "eq=a=b"])
        with patch.object(cuttle_pet, "_request", return_value={"ok": True}) as req:
            with patch.object(cuttle_pet, "_report", return_value=0) as report:
                code = cuttle_pet.cmd_react(args)
        req.assert_called_once_with("POST", "/behaviors/trigger",
                                    {"id": "rocket-launch",
                                     "params": {"message": "007", "n": "3",
                                                "flag": "true", "eq": "a=b"}})
        self.assertEqual(code, 0)

    def test_react_rejects_bare_param(self):
        import argparse
        from cli import cuttle_pet
        args = argparse.Namespace(id="x", param=["oops"])
        with self.assertRaises(cuttle_pet.CliError):
            cuttle_pet.cmd_react(args)

    def test_behaviors_lists_catalog(self):
        import argparse
        from cli import cuttle_pet
        args = argparse.Namespace()
        catalog = {"behaviors": [{"id": "rocket-launch", "name": "Rocket launch",
                                  "summary": "Rocket launch — 2 steps",
                                  "description": "Celebrate.",
                                  "params": [{"name": "message", "type": "string",
                                              "default": "Hi", "description": ""}],
                                  "cli": "python3 cli/cuttle_pet.py react rocket-launch"}]}
        with patch.object(cuttle_pet, "_request", return_value=catalog):
            import io
            from contextlib import redirect_stdout
            out = io.StringIO()
            with redirect_stdout(out):
                code = cuttle_pet.cmd_behaviors(args)
        self.assertEqual(code, 0)
        self.assertIn("rocket-launch", out.getvalue())
        self.assertIn("param message", out.getvalue())


if __name__ == "__main__":
    unittest.main()
