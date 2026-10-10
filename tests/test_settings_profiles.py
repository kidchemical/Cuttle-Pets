import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import server
from server import settings_profiles

GLB = b"glTF" + b"\x00" * 8
ASSET_KINDS = ("models", "dances", "audio", "pets", "props")


def make_dirs(root: Path) -> dict[str, Path]:
    dirs = {name: root / name for name in ASSET_KINDS}
    for directory in dirs.values():
        directory.mkdir(parents=True, exist_ok=True)
    return dirs


def snapshot() -> dict:
    value = {
        "modelPath": "/model/serve/custom.vrm", "ttsEnabled": True, "musicEnabled": True, "showText": True,
        "hideUI": False, "hideMood": False, "pinned": True, "collapsed": False,
        "musicSettings": {"bgm": "/audio/song.mp3"}, "headphoneFits": {},
        "tracking": "mouse", "gazeGain": 2.0, "volume": 0.5, "panelWidth": 400,
        "uiAlign": "right", "language": "en", "currentDance": "jile", "customDancePreset": None,
        "quality": {}, "bubbleSettings": {}, "animationSettings": {"url": "/dance/serve/custom.vmd"},
        "behaviorSettings": {}, "petSettings": {"file": "buddy.glb"},
        "propSettings": {"file": "lamp.glb"}, "lighting": {}, "cursorLight": {},
    }
    assert set(value) == settings_profiles.PROFILE_KEYS
    return value


class ProfileRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="temp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = make_dirs(self.root / "source")
        self.source["models"].joinpath("custom.vrm").write_bytes(GLB)
        self.source["dances"].joinpath("custom.vmd").write_bytes(b"vmd-custom")
        self.source["audio"].joinpath("song.mp3").write_bytes(b"audio-custom")
        self.source["pets"].joinpath("buddy.glb").write_bytes(GLB)
        self.source["props"].joinpath("lamp.glb").write_bytes(GLB)
        self.client = server.app.test_client()
        self.use_dirs(self.source, self.root / "data-source")

    def use_dirs(self, dirs: dict[str, Path], data_dir: Path):
        data_dir.mkdir(parents=True, exist_ok=True)
        for attr, name in (("MODELS_DIR", "models"), ("DANCES_DIR", "dances"),
                           ("AUDIO_DIR", "audio"), ("PETS_DIR", "pets"), ("PROPS_DIR", "props")):
            patcher = patch.object(server, attr, dirs[name])
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(server, "DATA_DIR", data_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def save_bundle(self) -> bytes:
        response = self.client.post("/settings-profiles/export", json={"name": "Shared Look", "settings": snapshot()})
        self.assertEqual(response.status_code, 200, response.get_data().decode("utf-8", "replace"))
        self.assertTrue(response.data.startswith(b"PK"))
        return response.data

    def load_bundle(self, data: bytes) -> dict:
        preview = self.client.post("/settings-profiles/import/preview",
                                   data={"file": (io.BytesIO(data), "shared.cuttleprofile")})
        self.assertEqual(preview.status_code, 200, preview.get_data(as_text=True))
        body = preview.get_json()
        self.assertEqual(len(body["preview"]["assets"]), 5)
        commit = self.client.post("/settings-profiles/import/commit", json={"token": body["token"]})
        self.assertEqual(commit.status_code, 200, commit.get_data(as_text=True))
        return commit.get_json()["settings"]

    def test_round_trip_into_clean_installation(self):
        data = self.save_bundle()
        self.assertFalse((self.root / "data-source" / "settings-profiles").exists())
        target = make_dirs(self.root / "target")
        self.use_dirs(target, self.root / "data-target")
        restored = self.load_bundle(data)
        self.assertEqual(restored["modelPath"], "/model/serve/custom.vrm")
        self.assertEqual(restored["animationSettings"], {"url": "/dance/serve/custom.vmd"})
        self.assertEqual(restored["musicSettings"], {"bgm": "/audio/song.mp3"})
        self.assertEqual(restored["petSettings"], {"file": "buddy.glb"})
        self.assertEqual(restored["propSettings"], {"file": "lamp.glb"})
        for kind, filename in (("models", "custom.vrm"), ("dances", "custom.vmd"),
                               ("audio", "song.mp3"), ("pets", "buddy.glb"), ("props", "lamp.glb")):
            self.assertTrue((target[kind] / filename).is_file(), f"{kind}/{filename} not installed")

    def test_reloading_same_bundle_reuses_assets(self):
        data = self.save_bundle()
        target = make_dirs(self.root / "target")
        self.use_dirs(target, self.root / "data-target")
        self.load_bundle(data)
        preview = self.client.post("/settings-profiles/import/preview",
                                   data={"file": (io.BytesIO(data), "shared.cuttleprofile")}).get_json()
        self.assertTrue(all(asset["alreadyInstalled"] for asset in preview["preview"]["assets"]))
        self.client.post("/settings-profiles/import/commit", json={"token": preview["token"]})
        self.assertEqual(sorted(p.name for p in target["models"].iterdir()), ["custom.vrm"])

    def test_export_requires_a_name(self):
        response = self.client.post("/settings-profiles/export", json={"settings": snapshot()})
        self.assertEqual(response.status_code, 400)

    def test_load_rejects_unknown_bundle(self):
        preview = self.client.post("/settings-profiles/import/preview",
                                   data={"file": (io.BytesIO(b"not a zip"), "bad.cuttleprofile")})
        self.assertEqual(preview.status_code, 400)

    def test_export_reports_missing_assets(self):
        self.source["models"].joinpath("custom.vrm").unlink()
        response = self.client.post("/settings-profiles/export", json={"name": "Broken", "settings": snapshot()})
        self.assertEqual(response.status_code, 400)
        self.assertIn("custom.vrm", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
