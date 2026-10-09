"""Local full-settings profiles and portable asset bundles."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import shutil
import stat
import tempfile
import time
import uuid
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, unquote, urlsplit

from flask import Blueprint, jsonify, request, send_file

PROFILE_FORMAT = "cuttle-pet-profile"
PROFILE_VERSION = 1
PROFILE_KEYS = {
    "modelPath", "ttsEnabled", "musicEnabled", "musicSettings", "headphoneFits", "showText",
    "hideUI", "tracking", "gazeGain", "volume", "uiAlign", "hideMood",
    "currentDance", "customDancePreset", "language", "pinned", "quality",
    "collapsed", "panelWidth", "bubbleSettings", "animationSettings", "behaviorSettings", "petSettings",
    "propSettings", "lighting", "cursorLight",
}
MAX_PROFILE_BYTES = 1024 * 1024 * 1024
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROFILE_FILES = 2048
MAX_SETTINGS_BYTES = 16 * 1024 * 1024
_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_STAGE_RE = re.compile(r"^[a-f0-9]{32}$")


def create_blueprint(data_dir, asset_dirs, app_version):
    bp = Blueprint("settings_profiles", __name__)

    def profile_dir() -> Path:
        return data_dir() / "settings-profiles"

    def stage_dir() -> Path:
        return data_dir() / ".profile-imports"

    def clean_stale_stages() -> None:
        root = stage_dir()
        if not root.is_dir():
            return
        cutoff = time.time() - 24 * 60 * 60
        for entry in root.iterdir():
            try:
                if _STAGE_RE.fullmatch(entry.name) and entry.is_dir() and entry.stat().st_mtime < cutoff:
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                continue

    def roots() -> dict[str, Path]:
        return asset_dirs()

    @bp.get("/settings-profiles")
    def list_profiles():
        directory = profile_dir()
        items = []
        if directory.is_dir():
            for path in sorted(directory.glob("*.json")):
                try:
                    profile = json.loads(path.read_text(encoding="utf-8"))
                    if isinstance(profile, dict) and _ID_RE.fullmatch(profile.get("id", "")):
                        items.append({"id": profile["id"], "name": profile.get("name", ""),
                                      "updatedAt": profile.get("updatedAt", ""),
                                      "source": profile.get("source")})
                except (OSError, ValueError):
                    continue
        return jsonify({"profiles": items})

    @bp.post("/settings-profiles")
    def save_profile():
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"ok": False, "error": "JSON object required"}), 400
        try:
            name = _clean_name(body.get("name"))
            snapshot = _clean_settings(body.get("settings"))
            profile_id = body.get("id") or uuid.uuid4().hex
            if not isinstance(profile_id, str) or not _ID_RE.fullmatch(profile_id):
                raise ValueError("Invalid profile ID")
            directory = profile_dir()
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{profile_id}.json"
            existing = _read_profile(directory, profile_id)
            source = "behavior-migration" if body.get("source") == "behavior-migration" else (existing or {}).get("source")
            profile = {"id": profile_id, "name": name, "schemaVersion": PROFILE_VERSION,
                       "settings": snapshot, "updatedAt": int(time.time())}
            if source == "behavior-migration":
                profile["source"] = source
            _atomic_json(path, profile)
            return jsonify({"ok": True, "profile": {"id": profile_id, "name": name}})
        except (ValueError, OSError) as error:
            return jsonify({"ok": False, "error": str(error)}), 400

    @bp.get("/settings-profiles/<profile_id>")
    def get_profile(profile_id: str):
        profile = _read_profile(profile_dir(), profile_id)
        if profile is None:
            return jsonify({"ok": False, "error": "Profile not found"}), 404
        return jsonify({"ok": True, "profile": profile})

    @bp.delete("/settings-profiles/<profile_id>")
    def delete_profile(profile_id: str):
        if not _ID_RE.fullmatch(profile_id):
            return jsonify({"ok": False, "error": "Profile not found"}), 404
        path = profile_dir() / f"{profile_id}.json"
        try:
            path.unlink()
        except FileNotFoundError:
            return jsonify({"ok": False, "error": "Profile not found"}), 404
        return jsonify({"ok": True})

    @bp.get("/settings-profiles/<profile_id>/export")
    def export_profile(profile_id: str):
        profile = _read_profile(profile_dir(), profile_id)
        if profile is None:
            return jsonify({"ok": False, "error": "Profile not found"}), 404
        try:
            archive = _export(profile, roots(), app_version(), stage_dir() / "exports")
        except (ValueError, OSError) as error:
            return jsonify({"ok": False, "error": str(error)}), 400
        filename = re.sub(r"[^A-Za-z0-9._-]+", "-", profile["name"]).strip("-._")[:60] or "Cuttle-Pet-Profile"
        response = send_file(archive, mimetype="application/zip", as_attachment=True,
                             download_name=f"{filename}.cuttleprofile", max_age=0)
        response.call_on_close(archive.close)
        return response

    @bp.post("/settings-profiles/import/preview")
    def preview_import():
        uploaded = request.files.get("file")
        if uploaded is None:
            return jsonify({"ok": False, "error": "Choose a profile bundle"}), 400
        clean_stale_stages()
        stage_id = uuid.uuid4().hex
        directory = stage_dir() / stage_id
        directory.mkdir(parents=True, exist_ok=False)
        archive_path = directory / "bundle.zip"
        try:
            total = 0
            with archive_path.open("wb") as output:
                while chunk := uploaded.stream.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_PROFILE_BYTES:
                        raise ValueError("Profile bundle exceeds the 1 GB compressed size limit")
                    output.write(chunk)
            manifest, settings, asset_rows = _validate_archive(archive_path, roots(), directory / "assets")
            profile_name = _clean_name(manifest.get("name"))
            existing_names = {item["name"].casefold() for item in _list_profiles(profile_dir())}
            suggested_name = profile_name
            suffix = 2
            while suggested_name.casefold() in existing_names:
                suggested_name = f"{profile_name} ({suffix})"
                suffix += 1
            _atomic_json(directory / "profile.json", {"name": profile_name, "settings": settings,
                                                         "manifest": manifest})
            total_bytes = sum(item["size"] for item in asset_rows)
            return jsonify({"ok": True, "token": stage_id,
                            "preview": {"name": profile_name, "suggestedName": suggested_name,
                                        "categories": list(settings), "assets": asset_rows,
                                        "totalBytes": total_bytes}})
        except (ValueError, OSError, EOFError, RuntimeError, NotImplementedError,
                TypeError, KeyError, OverflowError, zlib.error, zipfile.BadZipFile,
                json.JSONDecodeError) as error:
            shutil.rmtree(directory, ignore_errors=True)
            return jsonify({"ok": False, "error": str(error) or "Invalid profile bundle"}), 400

    @bp.post("/settings-profiles/import/commit")
    def commit_import():
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or not isinstance(body.get("token"), str) or not _STAGE_RE.fullmatch(body["token"]):
            return jsonify({"ok": False, "error": "Invalid import session"}), 400
        directory = stage_dir() / body["token"]
        try:
            staged = json.loads((directory / "profile.json").read_text(encoding="utf-8"))
            manifest = staged["manifest"]
            settings = staged["settings"]
            name = _clean_name(body.get("name") or staged["name"])
            profile_id = uuid.uuid4().hex
            mapping: dict[tuple[str, str], str] = {}
            created: list[Path] = []
            try:
                for asset in manifest["assets"]:
                    kind, asset_id = asset["kind"], asset["id"]
                    source = directory / "assets" / asset_id / asset["filename"]
                    target = _install_asset(source, asset, roots())
                    if target[1]:
                        created.append(target[0])
                    mapping[(kind, asset_id)] = _local_reference(kind, target[0])
                restored = _restore_refs(settings, mapping)
                profile_directory = profile_dir()
                profile_directory.mkdir(parents=True, exist_ok=True)
                _atomic_json(profile_directory / f"{profile_id}.json", {
                    "id": profile_id, "name": name, "schemaVersion": PROFILE_VERSION,
                    "settings": _clean_settings(restored), "updatedAt": int(time.time()),
                })
            except Exception:
                for path in created:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                raise
            return jsonify({"ok": True, "profile": {"id": profile_id, "name": name}})
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            return jsonify({"ok": False, "error": str(error) or "Could not import profile"}), 400
        finally:
            shutil.rmtree(directory, ignore_errors=True)

    @bp.post("/settings-profiles/import/cancel")
    def cancel_import():
        body = request.get_json(silent=True)
        token = body.get("token") if isinstance(body, dict) else None
        if isinstance(token, str) and _STAGE_RE.fullmatch(token):
            shutil.rmtree(stage_dir() / token, ignore_errors=True)
        return jsonify({"ok": True})

    return bp


def _clean_name(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("Profile name is required")
    name = " ".join("".join(char for char in value if char.isprintable()).split())[:60]
    if not name:
        raise ValueError("Profile name is required")
    return name


def _clean_settings(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Profile settings must be an object")
    settings = {key: item for key, item in value.items() if key in PROFILE_KEYS}
    boolean_keys = {"ttsEnabled", "musicEnabled", "showText", "hideUI", "hideMood", "pinned", "collapsed"}
    object_keys = {"musicSettings", "headphoneFits", "quality", "bubbleSettings", "animationSettings",
                   "behaviorSettings", "petSettings", "propSettings", "lighting", "cursorLight"}
    for key in boolean_keys.intersection(settings):
        if not isinstance(settings[key], bool):
            raise ValueError(f"Invalid {key} setting")
    for key in object_keys.intersection(settings):
        if not isinstance(settings[key], dict):
            raise ValueError(f"Invalid {key} setting")
    for key in ("modelPath", "currentDance"):
        if key in settings and not isinstance(settings[key], str):
            raise ValueError(f"Invalid {key} setting")
    if "language" in settings and settings["language"] not in ("en", "zh"):
        raise ValueError("Invalid language setting")
    if "tracking" in settings and settings["tracking"] not in ("mouse", "camera"):
        raise ValueError("Invalid tracking setting")
    if "uiAlign" in settings and settings["uiAlign"] not in ("left", "right"):
        raise ValueError("Invalid interface alignment setting")
    if settings.get("customDancePreset") is not None and not isinstance(settings.get("customDancePreset"), dict):
        raise ValueError("Invalid custom dance setting")
    for key in ("gazeGain", "volume", "panelWidth"):
        item = settings.get(key)
        if key in settings:
            try:
                valid_number = not isinstance(item, bool) and isinstance(item, (int, float)) and math.isfinite(item)
            except (OverflowError, TypeError):
                valid_number = False
            if not valid_number:
                raise ValueError(f"Invalid {key} setting")
            low, high = {"gazeGain": (0, 4), "volume": (0, 1), "panelWidth": (300, 640)}[key]
            if not low <= item <= high:
                raise ValueError(f"Invalid {key} setting")
    encoded = json.dumps(settings, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_SETTINGS_BYTES:
        raise ValueError("Profile settings are too large")
    return settings


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".profile-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_profile(directory: Path, profile_id: str) -> dict[str, Any] | None:
    if not _ID_RE.fullmatch(profile_id):
        return None
    try:
        profile = json.loads((directory / f"{profile_id}.json").read_text(encoding="utf-8"))
        if not isinstance(profile, dict) or profile.get("id") != profile_id:
            return None
        profile["name"] = _clean_name(profile.get("name"))
        profile["settings"] = _clean_settings(profile.get("settings"))
        return profile
    except (OSError, ValueError, TypeError):
        return None


def _list_profiles(directory: Path) -> list[dict[str, Any]]:
    result = []
    if directory.is_dir():
        for path in directory.glob("*.json"):
            try:
                profile = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(profile, dict) and _ID_RE.fullmatch(profile.get("id", "")):
                    result.append({"id": profile["id"], "name": profile.get("name", ""),
                                   "source": profile.get("source")})
            except (OSError, ValueError):
                continue
    return result


def _reference_path(kind: str, value: Any, directories: dict[str, Path]) -> tuple[Path, str] | None:
    if not isinstance(value, str) or not value:
        return None
    parsed = urlsplit(value)
    if parsed.netloc and (parsed.hostname not in ("localhost", "127.0.0.1", "::1") or parsed.username or parsed.password):
        return None
    route = unquote(parsed.path)
    allowed_routes = {
        "models": ("/model/serve/", "/model/project/"),
        "dances": ("/dance/serve/",),
        "audio": ("/audio/",),
    }
    if kind in allowed_routes:
        prefix = next((prefix for prefix in allowed_routes[kind] if route.startswith(prefix)), None)
        if prefix:
            name = PurePosixPath(route[len(prefix):]).name
            if not name or name in (".", "..") or "/" in route[len(prefix):]:
                return None
            search_dirs = [directories.get(kind)]
            if kind == "models" and prefix == "/model/project/":
                search_dirs.insert(0, directories.get("project_models"))
            for base in search_dirs:
                if base:
                    candidate = base / name
                    if candidate.is_file() and candidate.resolve().parent == base.resolve():
                        return candidate, name
        # Built-in animation and music files are served by the app itself and
        # remain ordinary app URLs in a portable profile. Custom files use the
        # /dance/serve or /audio routes above.
        if kind in ("dances", "audio") and route.startswith("/") and route.count("/") == 1:
            name = route[1:]
            if name and name not in (".", ".."):
                public = directories.get("public")
                if public:
                    candidate = public / name
                    if candidate.is_file() and candidate.resolve().parent == public.resolve():
                        return None
        # Also accept an absolute local path only when it resolves inside the
        # configured asset library; never read arbitrary sender/user paths.
        candidate_path = Path(value).expanduser()
        if candidate_path.is_absolute():
            for base in (directories.get(kind), directories.get("project_models") if kind == "models" else None):
                if base:
                    try:
                        candidate = candidate_path.resolve(strict=True)
                        if candidate.is_file() and candidate.is_relative_to(base.resolve()):
                            return candidate, candidate.name
                    except (OSError, ValueError):
                        pass
    else:
        name = PurePosixPath(value.replace("\\", "/")).name
        if name != value or name in (".", ".."):
            return None
        base = directories.get(kind)
        if base:
            candidate = base / name
            if candidate.is_file() and candidate.resolve().parent == base.resolve():
                return candidate, name
    return None


def _kind_for_reference(key: str, value: str, parents: tuple[str, ...]) -> str | None:
    if key == "modelPath":
        return "models"
    if key == "file" and "petSettings" in parents:
        return "pets"
    if key == "file" and "propSettings" in parents:
        return "props"
    if key in ("url", "vmdUrl") and "/dance/serve/" in value:
        return "dances"
    if key in ("bgm", "bgmUrl") and ("/audio/" in value or Path(urlsplit(value).path).suffix.lower() in (".mp3", ".wav", ".ogg")):
        return "audio"
    # Preset URLs can be a legacy bare filename; only accept known motion
    # suffixes when the value appears in a preset/url field.
    if key in ("url", "vmdUrl") and Path(urlsplit(value).path).suffix.lower() in (".vmd", ".vrma", ".fbx"):
        return "dances"
    if key in ("bgm", "bgmUrl") and Path(urlsplit(value).path).suffix.lower() in (".mp3", ".wav", ".ogg"):
        return "audio"
    return None


def _walk_refs(value: Any, callback, parents: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            kind = _kind_for_reference(key, child, parents) if isinstance(child, str) else None
            if kind:
                result[key] = callback(kind, child, parents)
            else:
                result[key] = _walk_refs(child, callback, parents + (key,))
        return result
    if isinstance(value, list):
        return [_walk_refs(child, callback, parents) for child in value]
    return value


def _asset_token(kind: str, asset_id: str) -> str:
    return f"asset://{kind}/{asset_id}"


def _bundle_filename(value: str) -> str:
    path = Path(value)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", path.stem).strip("-._")[:80] or "asset"
    return f"{stem}{path.suffix.lower()}"


def _token_parts(value: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"asset://(models|dances|audio|pets|props)/([a-f0-9]{32})", value)
    return (match.group(1), match.group(2)) if match else None


def _is_builtin_asset(kind: str, value: str, directories: dict[str, Path]) -> bool:
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return False
    route = unquote(parsed.path)
    if kind in ("models", "dances", "audio") and route.startswith("/") and route.count("/") == 1:
        public = directories.get("public")
        candidate = public / route[1:] if public else None
        return bool(candidate and candidate.is_file() and candidate.resolve().parent == public.resolve())
    return False


def _export(profile: dict[str, Any], directories: dict[str, Path], version: str, temporary_dir: Path):
    settings = _clean_settings(profile.get("settings"))
    inventory: dict[str, dict[str, Any]] = {}
    missing: list[str] = []

    def register_asset(kind: str, value: str) -> str | None:
        resolved = _reference_path(kind, value, directories)
        if resolved is None:
            if _is_builtin_asset(kind, value, directories):
                return None
            return None
        path, filename = resolved
        key = str(path.resolve())
        if key not in inventory:
            asset_id = uuid.uuid4().hex
            filename = _bundle_filename(filename)
            inventory[key] = {"id": asset_id, "kind": kind, "filename": filename,
                              "path": f"assets/{asset_id}/{filename}", "size": path.stat().st_size,
                              "sha256": _sha256_file(path), "source": path}
        return inventory[key]["id"]

    def collect(kind: str, value: str, _parents):
        if _token_parts(value):
            raise ValueError("Local profile contains an unresolved bundle reference")
        asset_id = register_asset(kind, value)
        if asset_id:
            return _asset_token(kind, asset_id)
        if not _is_builtin_asset(kind, value, directories):
            missing.append(value)
        return value

    portable = _walk_refs(copy.deepcopy(settings), collect)
    fit_map = settings.get("headphoneFits")
    if isinstance(fit_map, dict):
        portable_fits = {}
        for model_key, fit in fit_map.items():
            if not isinstance(model_key, str):
                continue
            model_id = register_asset("models", model_key)
            if model_id:
                portable_fits[_asset_token("models", model_id)] = fit
            else:
                portable_fits[model_key] = fit
                if urlsplit(model_key).path.startswith("/model/"):
                    missing.append(model_key)
        portable["headphoneFits"] = portable_fits
    if missing:
        raise ValueError("Required profile assets could not be found: " + ", ".join(sorted(set(missing))))
    manifest = {"format": PROFILE_FORMAT, "version": PROFILE_VERSION,
                "minimumAppVersion": version, "name": _clean_name(profile.get("name")),
                "assets": [{key: value for key, value in asset.items() if key != "source"}
                           for asset in inventory.values()]}
    if len(inventory) + 2 > MAX_PROFILE_FILES:
        raise ValueError("Profile contains too many required assets")
    manifest_text = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
    profile_text = json.dumps({"schemaVersion": PROFILE_VERSION, "settings": portable},
                              ensure_ascii=False, separators=(",", ":"))
    if sum(asset["size"] for asset in inventory.values()) + len(manifest_text.encode("utf-8")) + len(profile_text.encode("utf-8")) > MAX_EXPANDED_BYTES:
        raise ValueError("Profile bundle exceeds the 2 GB expanded size limit")
    temporary_dir.mkdir(parents=True, exist_ok=True)
    archive = tempfile.TemporaryFile(mode="w+b", dir=temporary_dir)
    try:
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            output.writestr("manifest.json", manifest_text)
            output.writestr("profile.json", profile_text)
            for asset in inventory.values():
                output.write(asset["source"], asset["path"])
        if archive.tell() > MAX_PROFILE_BYTES:
            raise ValueError("Profile bundle exceeds the 1 GB compressed size limit")
        archive.seek(0)
        return archive
    except Exception:
        archive.close()
        raise


def _validate_archive(path: Path, directories: dict[str, Path], extraction_dir: Path):
    with zipfile.ZipFile(path, "r") as archive:
        entries = archive.infolist()
        if len(entries) > MAX_PROFILE_FILES:
            raise ValueError("Profile bundle contains too many files")
        names: set[str] = set()
        expanded = 0
        for info in entries:
            name = info.filename
            pure = PurePosixPath(name)
            mode = (info.external_attr >> 16) & 0xFFFF
            if (not name or name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") for part in pure.parts) or
                    stat.S_ISLNK(mode)):
                raise ValueError("Profile bundle contains an unsafe archive path")
            if name in names:
                raise ValueError("Profile bundle contains duplicate paths")
            names.add(name)
            if info.is_dir():
                continue
            expanded += info.file_size
            if expanded > MAX_EXPANDED_BYTES:
                raise ValueError("Profile bundle exceeds the expanded size limit")
        if "manifest.json" not in names or "profile.json" not in names:
            raise ValueError("Profile bundle is missing its manifest or settings")
        if archive.getinfo("manifest.json").file_size > 2 * 1024 * 1024 or archive.getinfo("profile.json").file_size > MAX_SETTINGS_BYTES:
            raise ValueError("Profile manifest or settings are too large")
        manifest = json.loads(archive.read("manifest.json"))
        portable = json.loads(archive.read("profile.json"))
        if not isinstance(manifest, dict) or manifest.get("format") != PROFILE_FORMAT or manifest.get("version") != PROFILE_VERSION:
            raise ValueError("Unsupported profile bundle format")
        if not isinstance(manifest.get("minimumAppVersion"), str):
            raise ValueError("Profile manifest is missing its minimum app version")
        _clean_name(manifest.get("name"))
        if not isinstance(portable, dict) or portable.get("schemaVersion") != PROFILE_VERSION:
            raise ValueError("Unsupported profile settings version")
        settings = _clean_settings(portable.get("settings"))
        if set(settings) != PROFILE_KEYS:
            raise ValueError("Profile is missing one or more required settings")
        assets = manifest.get("assets")
        if not isinstance(assets, list) or len(assets) > MAX_PROFILE_FILES - 2:
            raise ValueError("Invalid profile asset list")
        ids, declared_paths = set(), {"manifest.json", "profile.json"}
        types = {"models": {".vrm"}, "dances": {".vmd", ".vrma", ".fbx"},
                 "audio": {".mp3", ".wav", ".ogg"}, "pets": {".glb"}, "props": {".glb"}}
        extraction_dir.mkdir(parents=True, exist_ok=False)
        previews = []
        for asset in assets:
            if not isinstance(asset, dict):
                raise ValueError("Invalid profile asset entry")
            asset_id, kind, filename, relative = asset.get("id"), asset.get("kind"), asset.get("filename"), asset.get("path")
            if (not isinstance(asset_id, str) or not _ID_RE.fullmatch(asset_id) or asset_id in ids or
                    kind not in types or not isinstance(filename, str) or Path(filename).name != filename or "\\" in filename or
                    Path(filename).suffix.lower() not in types[kind] or not isinstance(relative, str) or
                    relative != f"assets/{asset_id}/{filename}" or relative in declared_paths):
                raise ValueError("Invalid profile asset metadata")
            ids.add(asset_id)
            declared_paths.add(relative)
            info = archive.getinfo(relative)
            size = asset.get("size")
            digest = asset.get("sha256")
            if info.is_dir() or not isinstance(size, int) or size != info.file_size or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError(f"Invalid size or checksum for {filename}")
            if kind in ("models", "pets", "props") and size < 12:
                raise ValueError(f"{filename} is not a valid GLB/VRM asset")
            target = extraction_dir / asset_id / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            digest_state = hashlib.sha256()
            written = 0
            prefix = bytearray()
            with archive.open(relative, "r") as incoming, target.open("xb") as outgoing:
                while chunk := incoming.read(1024 * 1024):
                    written += len(chunk)
                    if written > size or written > MAX_EXPANDED_BYTES:
                        raise ValueError(f"Expanded asset {filename} exceeds its declared size")
                    if len(prefix) < 4:
                        prefix.extend(chunk[:4 - len(prefix)])
                    digest_state.update(chunk)
                    outgoing.write(chunk)
            if written != size or digest_state.hexdigest() != digest:
                raise ValueError(f"Checksum mismatch for {filename}")
            if kind in ("models", "pets", "props") and prefix != b"glTF":
                raise ValueError(f"{filename} is not a valid GLB/VRM asset")
            base = directories.get(kind)
            existing = base / filename if base else None
            same_content = bool(existing and existing.is_file() and _sha256_file(existing) == digest)
            previews.append({"id": asset_id, "kind": kind, "filename": filename, "size": size,
                             "alreadyInstalled": same_content})
        actual_files = {name for name in names if not name.endswith("/")}
        if actual_files != declared_paths:
            raise ValueError("Profile bundle has missing or unexpected files")
        asset_kinds = {asset["id"]: asset["kind"] for asset in assets}
        referenced = _validate_asset_references(settings, asset_kinds)
        if referenced != ids:
            raise ValueError("Profile bundle contains an unreferenced asset")
        return manifest, settings, previews


def _validate_asset_references(settings: dict[str, Any], asset_kinds: dict[str, str]) -> set[str]:
    referenced: set[str] = set()

    def check(token: str, expected: str | None) -> None:
        parts = _token_parts(token)
        if parts is None or expected is None:
            raise ValueError("Profile settings contain a malformed or misplaced asset reference")
        kind, asset_id = parts
        if kind != expected or asset_kinds.get(asset_id) != kind:
            raise ValueError("Profile settings contain an unresolved asset reference")
        referenced.add(asset_id)

    def walk(value: Any, key: str = "", parents: tuple[str, ...] = ()) -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                if key == "headphoneFits" and isinstance(child_key, str) and child_key.startswith("asset://"):
                    check(child_key, "models")
                elif key == "headphoneFits" and isinstance(child_key, str):
                    if urlsplit(child_key).scheme or urlsplit(child_key).path.startswith("/model/"):
                        raise ValueError("Profile contains a sender-local headphone fit reference")
                walk(child, child_key, parents + ((key,) if key else ()))
        elif isinstance(value, list):
            for child in value:
                walk(child, key, parents)
        elif isinstance(value, str) and value.startswith("asset://"):
            if key == "modelPath":
                expected = "models"
            elif key == "file" and "petSettings" in parents:
                expected = "pets"
            elif key == "file" and "propSettings" in parents:
                expected = "props"
            elif key in ("url", "vmdUrl"):
                expected = "dances"
            elif key in ("bgm", "bgmUrl"):
                expected = "audio"
            else:
                expected = None
            check(value, expected)
        elif isinstance(value, str) and value:
            if key == "modelPath":
                route = unquote(urlsplit(value).path)
                if urlsplit(value).scheme or urlsplit(value).netloc or not route.startswith("/") or route.count("/") != 1 or not route.lower().endswith(".vrm"):
                    raise ValueError("Portable profile contains a non-portable model path")
            elif key == "file" and "petSettings" in parents:
                raise ValueError("Portable profile is missing a configured pet asset")
            elif key == "file" and "propSettings" in parents:
                raise ValueError("Portable profile is missing a configured prop asset")
            elif key in ("url", "vmdUrl", "bgm", "bgmUrl"):
                parsed = urlsplit(value)
                route = unquote(parsed.path)
                suffix = Path(route).suffix.lower()
                supported = {".vmd", ".vrma", ".fbx"} if key in ("url", "vmdUrl") else {".mp3", ".wav", ".ogg"}
                if parsed.scheme or parsed.netloc or (suffix in supported and (".." in PurePosixPath(route).parts or route.startswith(("/dance/serve/", "/audio/")))):
                    raise ValueError("Portable profile contains a sender-local animation or audio path")

    walk(settings)
    return referenced


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _install_asset(source: Path, asset: dict[str, Any], directories: dict[str, Path]) -> tuple[Path, bool]:
    directory = directories[asset["kind"]]
    directory.mkdir(parents=True, exist_ok=True)
    original = directory / asset["filename"]
    digest = asset["sha256"]
    if original.is_file() and _sha256_file(original) == digest:
        return original, False
    stem, suffix = Path(asset["filename"]).stem, Path(asset["filename"]).suffix
    target = original
    index = 2
    while target.exists():
        target = directory / f"{stem}-{index}{suffix}"
        if target.is_file() and _sha256_file(target) == digest:
            return target, False
        index += 1
    try:
        with source.open("rb") as incoming, target.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
            outgoing.flush()
            os.fsync(outgoing.fileno())
    except Exception:
        try:
            target.unlink()
        except OSError:
            pass
        raise
    return target, True


def _local_reference(kind: str, path: Path) -> str:
    name = path.name
    encoded = quote(name)
    route = {"models": f"/model/serve/{encoded}", "dances": f"/dance/serve/{encoded}",
             "audio": f"/audio/{encoded}", "pets": name, "props": name}
    return route[kind]


def _restore_refs(value: Any, mapping: dict[tuple[str, str], str], parents: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if isinstance(child, str) and (parts := _token_parts(child)):
                kind, asset_id = parts
                if key == "modelPath" and kind == "models":
                    result[key] = mapping[(kind, asset_id)]
                elif key == "file" and kind == "pets" and "petSettings" in parents:
                    result[key] = PurePosixPath(mapping[(kind, asset_id)]).name
                elif key == "file" and kind == "props" and "propSettings" in parents:
                    result[key] = PurePosixPath(mapping[(kind, asset_id)]).name
                elif key in ("url", "vmdUrl") and kind == "dances":
                    result[key] = mapping[(kind, asset_id)]
                elif key in ("bgm", "bgmUrl") and kind == "audio":
                    result[key] = mapping[(kind, asset_id)]
                else:
                    result[key] = child
            else:
                result[key] = _restore_refs(child, mapping, parents + (key,))
        # Fit is keyed by the selected model URL, so remap that key too.
        if "headphoneFits" in parents:
            result = {_restore_model_key(k, mapping): v for k, v in result.items()}
        return result
    if isinstance(value, list):
        return [_restore_refs(child, mapping, parents) for child in value]
    if isinstance(value, str) and (parts := _token_parts(value)):
        return mapping.get(parts, value)
    return value


def _restore_model_key(key: str, mapping: dict[tuple[str, str], str]) -> str:
    parts = _token_parts(key)
    return mapping.get(parts, key) if parts else key
