"""HUD changes preserve controls, map data and unrelated Synapse options."""
import importlib.util
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("client_hud", Path(__file__).with_name("client-hud.py"))
hud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hud)


class HudTest(unittest.TestCase):
    def make_game(self, root):
        game = Path(root)
        profiles = game / "config/xaero/minimap/profiles"
        profiles.mkdir(parents=True)
        (profiles.parent / "client.cfg").write_text("current_profile = personal\n")
        (profiles / "personal.cfg").write_text("profile_name = My map\ndisplay_minimap = true\ndeathpoints = true\n")
        (profiles / "default.cfg").write_text("display_minimap = true\n")
        (game / "options.txt").write_text("guiScale:3\nchatScale:1.0\nrenderDistance:4\nkey_aircraft.dismount:key.keyboard.f6\n")
        (game / "config/synapse-client.toml").write_text('[server]\nport = 25610\nauthToken = "keep-me"\n[features]\nscreenshotEnabled = true\n')
        return game

    def test_current_profile_only_and_controls_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            game = self.make_game(root)
            with patch.object(hud.profile, "processes_using", return_value=[]):
                hud.apply(game, enable_video=True)
                self.assertEqual(hud.apply(game, enable_video=True), [])
            options = (game / "options.txt").read_text()
            self.assertIn("guiScale:1\n", options)
            self.assertIn("renderDistance:4\n", options)
            self.assertIn("key_aircraft.dismount:key.keyboard.f6\n", options)
            self.assertEqual((game / "config/xaero/minimap/profiles/personal.cfg").read_text(),
                             "profile_name = My map\ndisplay_minimap = false\ndeathpoints = true\n")
            self.assertEqual((game / "config/xaero/minimap/profiles/default.cfg").read_text(), "display_minimap = true\n")
            config = tomllib.loads((game / "config/synapse-client.toml").read_text())
            self.assertEqual(config, {"server": {"port": 25610, "authToken": "keep-me"}, "features": {
                "screenshotEnabled": True, "videoEnabled": True, "hideDayCounterSidebar": True}})

    def test_live_client_and_unknown_profile_refuse_without_partial_edits(self):
        with tempfile.TemporaryDirectory() as root:
            game = self.make_game(root)
            before = (game / "options.txt").read_text()
            with patch.object(hud.profile, "processes_using", return_value=[123]):
                with self.assertRaisesRegex(ValueError, "stop it first"):
                    hud.apply(game)
            self.assertEqual((game / "options.txt").read_text(), before)
            (game / "config/xaero/minimap/client.cfg").write_text("current_profile = ../../elsewhere\n")
            with patch.object(hud.profile, "processes_using", return_value=[]):
                with self.assertRaisesRegex(ValueError, "current Xaero"):
                    hud.apply(game)
            self.assertEqual((game / "options.txt").read_text(), before)

    def test_hud_does_not_enable_video_unless_requested(self):
        before = '[features]\nvideoEnabled = false\n[other]\nfoo = "unchanged"\n'
        after = tomllib.loads(hud.synapse_features(before, False))
        self.assertEqual(after, {"features": {"videoEnabled": False, "hideDayCounterSidebar": True}, "other": {"foo": "unchanged"}})


if __name__ == "__main__":
    unittest.main()
