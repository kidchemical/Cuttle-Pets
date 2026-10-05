"""Pets/props: server validation, catalog, control endpoint, and CLI wiring."""
import argparse
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from server import server

from cli import cuttle_pet


def _pet(entry_id="chao"):
    return {"id": entry_id, "name": "Chao", "enabled": True, "file": "chao.glb",
            "asset": {"parts": [], "clips": ["Idle"], "bones": [], "materials": []},
            "expressions": [{"id": "heart", "label": "Heart", "set": {}}]}


class NormalizeTests(unittest.TestCase):
    def test_valid_shapes(self):
        self.assertEqual(server._normalize_companion_action(
            {"kind": "pet", "id": "chao", "action": "show"}),
            {"kind": "pet", "id": "chao", "action": "show"})
        self.assertEqual(server._normalize_companion_action(
            {"kind": "pet", "id": "chao", "action": "play", "value": "clip:Idle", "loop": True}),
            {"kind": "pet", "id": "chao", "action": "play", "value": "clip:Idle", "loop": True})

    def test_rejects_bad_shapes(self):
        self.assertIsNone(server._normalize_companion_action({"kind": "dog", "id": "chao", "action": "show"}))
        self.assertIsNone(server._normalize_companion_action({"kind": "pet", "id": "chao", "action": "wear"}))
        self.assertIsNone(server._normalize_companion_action({"kind": "pet", "id": "chao", "action": "play"}))
        self.assertIsNone(server._normalize_companion_action({"kind": "pet", "id": "chao", "action": "move", "value": "moon"}))
        self.assertIsNone(server._normalize_companion_action({"kind": "prop", "id": "hat", "action": "play", "value": "hop"}))

    def test_expression_hold_clamped(self):
        action = server._normalize_companion_action(
            {"kind": "pet", "id": "chao", "action": "expression", "value": "heart", "durationMs": 10 ** 9})
        self.assertEqual(action["durationMs"], 600000)

    def test_actions_capped_at_six(self):
        actions = [{"kind": "pet", "id": "chao", "action": "show"}] * 8
        self.assertEqual(len(server._normalize_companion_actions(actions)), 6)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(dir="temp")
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "settings.json"
        self.path.write_text(json.dumps({
            "petSettings": {"pets": [_pet()]},
            "propSettings": {"props": [{"id": "hat", "name": "Hat", "enabled": True, "file": "hat.glb"}]},
        }))
        replacement = patch.object(server, "SETTINGS_PATH", self.path)
        replacement.start()
        self.addCleanup(replacement.stop)
        self.client = server.app.test_client()

    def test_catalog_lists_pets_and_props(self):
        data = self.client.get("/companions").get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["pets"][0]["id"], "chao")
        self.assertIn("heart", data["pets"][0]["expressions"])
        self.assertIn("clip:Idle", data["pets"][0]["moves"])
        self.assertEqual(data["props"][0]["id"], "hat")
        self.assertIn("show", data["actions"]["pet"])

    def test_control_unknown_id_is_404(self):
        res = self.client.post("/companion", json={"kind": "pet", "id": "nope", "action": "show"})
        self.assertEqual(res.status_code, 404)

    def test_control_rejects_unknown_expression(self):
        res = self.client.post("/companion", json={"kind": "pet", "id": "chao", "action": "expression", "value": "nope"})
        self.assertEqual(res.status_code, 400)

    def test_control_delivers_valid_action(self):
        res = self.client.post("/companion", json={"kind": "pet", "id": "chao", "action": "show"})
        data = res.get_json()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["payload"], {"companion": {"kind": "pet", "id": "chao", "action": "show"}})


class CliTests(unittest.TestCase):
    def test_companion_builds_body(self):
        ns = argparse.Namespace(kind="pet", id="chao", action="play", value="hop", loop=True, hold=None)
        with patch.object(cuttle_pet, "_request", return_value={"ok": True}) as req:
            with redirect_stdout(io.StringIO()):
                code = cuttle_pet.cmd_companion(ns)
        req.assert_called_once_with("POST", "/companion",
                                    {"kind": "pet", "id": "chao", "action": "play", "value": "hop", "loop": True})
        self.assertEqual(code, 0)

    def test_companion_hold_becomes_duration(self):
        ns = argparse.Namespace(kind="pet", id="chao", action="expression", value="heart", loop=False, hold=2.5)
        with patch.object(cuttle_pet, "_request", return_value={"ok": True}) as req:
            with redirect_stdout(io.StringIO()):
                cuttle_pet.cmd_companion(ns)
        req.assert_called_once_with("POST", "/companion",
                                    {"kind": "pet", "id": "chao", "action": "expression",
                                     "value": "heart", "durationMs": 2500})

    def test_companions_lists_catalog(self):
        ns = argparse.Namespace()
        body = {"ok": True, "pets": [{"id": "chao", "name": "Chao", "expressions": ["heart"],
                                      "moves": ["hop"], "anchors": ["shoulder"]}], "props": []}
        with patch.object(cuttle_pet, "_request", return_value=body):
            out = io.StringIO()
            with redirect_stdout(out):
                code = cuttle_pet.cmd_companions(ns)
        self.assertEqual(code, 0)
        self.assertIn("chao", out.getvalue())


if __name__ == "__main__":
    unittest.main()
