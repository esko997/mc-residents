"""Slim client profiles and launch.sh wiring; temporary directories only, no
Minecraft, systemd or network.

Run: python3 -m unittest discover -s full-client/tools -p 'test_client_*.py' -v
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

TOOLS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("client_profile", TOOLS / "client-profile.py")
cp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cp)
LAUNCH = TOOLS.parent / "launch.sh"


def forge_jar(path, mod_id, requires=(), optional=(), raw=None):
    deps = "".join(f'[[dependencies.{mod_id}]]\nmodId="{d}"\nmandatory=true\nside="BOTH"\n' for d in requires)
    deps += "".join(f'[[dependencies.{mod_id}]]\nmodId="{d}"\nmandatory=false\nside="BOTH"\n' for d in optional)
    text = raw if raw is not None else f'modLoader="javafml"\n[[mods]]\nmodId="{mod_id}"\nversion="1"\n{deps}'
    with zipfile.ZipFile(path, "w") as jar:
        jar.writestr("META-INF/mods.toml", text)


def fabric_jar(path, mod_id, depends=()):
    with zipfile.ZipFile(path, "w") as jar:
        jar.writestr("fabric.mod.json", json.dumps({"id": mod_id, "depends": {d: "*" for d in depends}}))


SYNAPSE_TOML = "#Synapse\n[server]\n\t#HTTP server listen port.\n\tport = 25599\n\tautoPort = true\n\n[state]\n\tradius = 32.0\n"
OPTIONS = "version:3465\nrenderDistance:4\nguiScale:3\nao:true\nmipmapLevels:4\nkey_key.jump:key.keyboard.space\n"


def make_source(root, extra=()):
    game = root / "game-test"
    (game / "mods" / ".connector").mkdir(parents=True)
    (game / "mods" / ".connector" / "cache.jar").write_bytes(b"x")
    (game / "mods" / "old.jar.disabled").write_bytes(b"x")
    forge_jar(game / "mods" / "embeddium.jar", "embeddium")
    forge_jar(game / "mods" / "oculus.jar", "oculus", requires=["embeddium"])
    forge_jar(game / "mods" / "particlerain.jar", "particlerain")
    forge_jar(game / "mods" / "visuality.jar", "visuality")
    forge_jar(game / "mods" / "spr.jar", "sound_physics_remastered")
    fabric_jar(game / "mods" / "continuity.jar", "continuity", depends=["fabricloader"])
    forge_jar(game / "mods" / "xaerominimap.jar", "xaerominimap")
    forge_jar(game / "mods" / "xaeroworldmap.jar", "xaeroworldmap")
    forge_jar(game / "mods" / "ftbxaerocompat.jar", "ftbxaerocompat", requires=["architectury"])
    forge_jar(game / "mods" / "synapse.jar", "synapse", optional=["oculus"])
    for name, mod_id, requires in extra:
        forge_jar(game / "mods" / name, mod_id, requires=requires)
    (game / "config").mkdir()
    (game / "config" / "synapse-client.toml").write_text(SYNAPSE_TOML)
    (game / "config" / "jei-client.toml").write_text("a = 1\n")
    (game / "options.txt").write_text(OPTIONS)
    (game / "logs").mkdir()
    (game / "logs" / "latest.log").write_text("old run\n")
    (game / "XaeroWorldMap").mkdir()
    (game / "XaeroWorldMap" / "tile").write_bytes(b"\0" * 100)
    (game / "servers.dat").write_bytes(b"servers")
    return game


def tree_digest(root):
    digest = hashlib.sha256()
    for path in sorted(Path(root).rglob("*")):
        digest.update(str(path.relative_to(root)).encode())
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()


class Derive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def derive(self, game, profile, dest="game-slim", **kw):
        return cp.derive(game, self.root / dest, profile, 25631, proc=self.proc, **kw)

    def test_cli_derives_without_mistaking_itself_for_a_running_client(self):
        game = make_source(self.root)
        dest = self.root / "cli-profile"
        before = tree_digest(game)
        result = subprocess.run([
            sys.executable, str(TOOLS / "client-profile.py"), "derive",
            "--source", str(game), "--dest", str(dest),
            "--profile", "options", "--synapse-port", "25631",
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cp.read_synapse_port((dest / "config" / "synapse-client.toml").read_text()), (25631, False))
        self.assertEqual(tree_digest(game), before)

    def test_visual_leaves_out_only_its_groups_and_never_touches_the_source(self):
        game = make_source(self.root)
        before = tree_digest(game)
        report = self.derive(game, "visual")
        dest = self.root / "game-slim"
        self.assertEqual(tree_digest(game), before)
        kept = sorted(p.name for p in (dest / "mods").iterdir())
        self.assertEqual(kept, ["embeddium.jar", "ftbxaerocompat.jar", "synapse.jar",
                                "xaerominimap.jar", "xaeroworldmap.jar"])
        self.assertEqual(sorted(e["jar"] for e in report["excluded"]),
                         ["continuity.jar", "oculus.jar", "particlerain.jar", "spr.jar", "visuality.jar"])
        # Hard links, not copies: no extra disk and the same bytes Forge loaded before.
        self.assertEqual((dest / "mods" / "embeddium.jar").stat().st_ino, (game / "mods" / "embeddium.jar").stat().st_ino)
        self.assertFalse((dest / "logs").exists())
        self.assertFalse((dest / "XaeroWorldMap").exists())
        self.assertEqual((dest / "config" / "jei-client.toml").read_text(), "a = 1\n")
        self.assertEqual((dest / "servers.dat").read_bytes(), b"servers")
        options = (dest / "options.txt").read_text().splitlines()
        self.assertIn("mipmapLevels:0", options)
        self.assertIn("ao:false", options)
        self.assertIn("guiScale:3", options)          # GUI legibility untouched
        self.assertIn("renderDistance:4", options)    # reach horizon untouched unless asked
        self.assertIn("key_key.jump:key.keyboard.space", options)
        self.assertEqual(cp.read_synapse_port((dest / "config" / "synapse-client.toml").read_text()), (25631, False))
        marker = json.loads((dest / cp.MARKER).read_text())
        self.assertEqual(marker["profile"], "visual")
        self.assertEqual(marker["groups"]["shaders"]["matched_mod_ids"], ["oculus"])

    def test_nomap_removes_the_xaero_compat_mixin_with_the_maps(self):
        game = make_source(self.root)
        self.derive(game, "visual-nomap")
        kept = sorted(p.name for p in (self.root / "game-slim" / "mods").iterdir())
        self.assertEqual(kept, ["embeddium.jar", "synapse.jar"])

    def test_refuses_when_a_kept_mod_requires_a_removed_one(self):
        game = make_source(self.root, extra=[("shaderaddon.jar", "shaderaddon", ["oculus"])])
        with self.assertRaisesRegex(cp.ProfileError, r"shaderaddon.jar requires removed mod\(s\) \['oculus'\]"):
            self.derive(game, "visual")
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith((".game-slim", "game-slim"))], [])

    def test_refuses_a_group_whose_mod_ids_are_absent(self):
        game = make_source(self.root)
        (game / "mods" / "continuity.jar").unlink()
        with self.assertRaisesRegex(cp.ProfileError, "group connected-textures: none of"):
            self.derive(game, "visual")

    def test_refuses_a_source_a_running_client_uses(self):
        game = make_source(self.root)
        (self.proc / "4242").mkdir()
        (self.proc / "4242" / "cmdline").write_bytes(b"java\0--gameDir\0" + str(game.resolve()).encode() + b"\0")
        with self.assertRaisesRegex(cp.ProfileError, "pids \\[4242\\]"):
            self.derive(game, "options")

    def test_refuses_existing_destination_and_oversized_copy(self):
        game = make_source(self.root)
        (self.root / "taken").mkdir()
        with self.assertRaisesRegex(cp.ProfileError, "already exists"):
            self.derive(game, "baseline", dest="taken")
        with self.assertRaisesRegex(cp.ProfileError, "limit 10"):
            self.derive(game, "baseline", max_copy_bytes=10)

    def test_baseline_changes_only_the_synapse_port(self):
        game = make_source(self.root)
        report = self.derive(game, "baseline")
        dest = self.root / "game-slim"
        self.assertEqual(report["excluded"], [])
        self.assertEqual((dest / "options.txt").read_text(), OPTIONS)
        self.assertEqual(len(list((dest / "mods").iterdir())), 10)

    def test_render_distance_is_explicit(self):
        game = make_source(self.root)
        self.derive(game, "options", render_distance=3)
        self.assertIn("renderDistance:3", (self.root / "game-slim" / "options.txt").read_text().splitlines())
        with self.assertRaisesRegex(cp.ProfileError, "render distance"):
            self.derive(game, "options", dest="other", render_distance=1)


class LaunchCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "proc").mkdir()
        self.game = make_source(self.root)
        cp.derive(self.game, self.root / "slim", "visual", 25631, proc=self.root / "proc")
        self.slim = self.root / "slim"

    def tearDown(self):
        self.tmp.cleanup()

    def test_plain_directory_without_expectation_is_left_alone(self):
        self.assertIsNone(cp.launch_check(self.game))
        self.assertEqual((self.game / "options.txt").read_text(), OPTIONS)

    def test_reapplies_options_and_port_the_game_rewrote(self):
        (self.slim / "options.txt").write_text("ao:true\nmipmapLevels:4\nguiScale:2\n")
        (self.slim / "config" / "synapse-client.toml").write_text(SYNAPSE_TOML)
        result = cp.launch_check(self.slim, "visual")
        self.assertEqual(result["notes"], ["options re-applied", "synapse port re-pinned"])
        lines = (self.slim / "options.txt").read_text().splitlines()
        self.assertIn("ao:false", lines)
        self.assertIn("guiScale:2", lines)
        self.assertEqual(cp.read_synapse_port((self.slim / "config" / "synapse-client.toml").read_text()), (25631, False))

    def test_refusals(self):
        with self.assertRaisesRegex(cp.ProfileError, "not a derived profile directory"):
            cp.launch_check(self.game, "visual")
        with self.assertRaisesRegex(cp.ProfileError, "holds profile visual"):
            cp.launch_check(self.slim, "visual-nomap")
        os.link(self.game / "mods" / "oculus.jar", self.slim / "mods" / "oculus.jar")
        with self.assertRaisesRegex(cp.ProfileError, "removed jars are back"):
            cp.launch_check(self.slim)


class Parsing(unittest.TestCase):
    def test_invalid_toml_falls_back_to_conservative_requirements(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.jar"
            forge_jar(path, "x", raw='[[mods]]\nmodId="weird"\nmodId="dup"\n[[dependencies.weird]]\nmodId="oculus"\nmandatory=false\n')
            meta = cp.jar_metadata(path)
        self.assertEqual(meta["ids"], ["weird", "dup"])
        self.assertEqual(meta["requires"], ["oculus"])
        self.assertIn("treated as required", meta["error"])

    def test_server_only_and_optional_dependencies_do_not_block(self):
        data = {"dependencies": {"m": [{"modId": "a", "mandatory": True, "side": "SERVER"},
                                       {"modId": "b", "mandatory": False},
                                       {"modId": "c", "type": "required"}]}}
        self.assertEqual(cp._forge_requirements(data), {"c"})

    def test_synapse_port_added_when_section_missing(self):
        text = cp.set_synapse_port("[state]\n\tradius = 1\n", 25640)
        self.assertEqual(cp.read_synapse_port(text), (25640, False))


class LaunchScript(unittest.TestCase):
    """launch.sh with a stub portablemc: default arguments are unchanged."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        (self.base / "venv" / "bin").mkdir(parents=True)
        stub = self.base / "venv" / "bin" / "portablemc"
        stub.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$GARY_CLIENT_HOME/args"\n')
        stub.chmod(0o755)
        (self.base / "proc").mkdir()
        self.game = make_source(self.base)

    def tearDown(self):
        self.tmp.cleanup()

    def launch(self, **env):
        full = {"PATH": os.environ["PATH"], "HOME": str(self.base), "GARY_CLIENT_HOME": str(self.base),
                "GAME_DIR": str(self.game), "GARY_CLIENT_PROFILE_TOOL": str(TOOLS / "client-profile.py"),
                "DISPLAY": ":0", **env}
        done = subprocess.run(["bash", str(LAUNCH), "slim_a"], env=full, capture_output=True, text=True, timeout=30)
        args = (self.base / "args").read_text().splitlines() if (self.base / "args").exists() else None
        return done, args

    def test_default_launch_arguments_unchanged(self):
        done, args = self.launch()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(args, ["--main-dir", f"{self.base}/main", "start", "--resolution", "854x480",
                                "--mc-dir", str(self.game), "--jvm", f"{self.base}/jdk17/bin/java",
                                "--jvm-arg=-Xmx4G", "--jvm-arg=-Xms512m", "--username", "slim_a",
                                "--join-server", "192.168.1.233", "--join-server-port", "25570",
                                "forge::1.20.1-47.4.10"])
        self.assertEqual((self.game / "options.txt").read_text(), OPTIONS)

    def test_small_resolution_and_missing_profile_refuse_to_start(self):
        done, args = self.launch(GARY_CLIENT_RESOLUTION="640x360")
        self.assertEqual((done.returncode, args), (2, None))
        done, args = self.launch(GARY_CLIENT_PROFILE="visual")
        self.assertEqual((done.returncode, args), (2, None))
        self.assertIn("refusing to start the unslimmed client", done.stderr)

    def test_derived_directory_is_checked_before_start(self):
        slim = self.base / "slim"
        cp.derive(self.game, slim, "visual", 25631, proc=self.base / "proc")
        (slim / "options.txt").write_text("ao:true\n")
        done, args = self.launch(GAME_DIR=str(slim), GARY_CLIENT_PROFILE="visual", GARY_CLIENT_RESOLUTION="1280x720")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("client profile visual", done.stderr)
        self.assertIn("ao:false", (slim / "options.txt").read_text().splitlines())
        self.assertEqual(args[args.index("--resolution") + 1], "1280x720")
        self.assertEqual(args[args.index("--mc-dir") + 1], str(slim))


if __name__ == "__main__":
    unittest.main()
