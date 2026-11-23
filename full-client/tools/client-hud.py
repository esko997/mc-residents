#!/usr/bin/env python3
"""Apply the resident viewing HUD to a stopped client, without removing any mods.

The caller must back up the game configuration first. The settings affect this
client only: no scoreboard commands, world changes or resident input are sent.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import re
import tempfile
import tomllib

_spec = importlib.util.spec_from_file_location("client_profile", Path(__file__).with_name("client-profile.py"))
profile = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(profile)

HUD_OPTIONS = {
    "guiScale": "1",
    "chatScale": "0.9",
    "chatWidth": "0.75",
    "chatHeightFocused": "0.5",
    "chatHeightUnfocused": "0.18",
}


def setting(text, key, value):
    """Xaero's profile format is key = value, not TOML (strings are unquoted)."""
    pattern = re.compile(r"^(\s*)" + re.escape(key) + r"\s*=.*$", re.MULTILINE)
    matches = list(pattern.finditer(text))
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one {key} setting; found {len(matches)}")
    return pattern.sub(lambda match: f"{match[1]}{key} = {value}", text)


def synapse_features(text, enable_video):
    data = tomllib.loads(text)
    overrides = {"hideDayCounterSidebar": True}
    if enable_video:
        overrides["videoEnabled"] = True
    lines, out, section, seen = text.splitlines(), [], None, set()
    for line in lines:
        header = re.match(r"^\s*\[([^\]]+)\]\s*(?:#.*)?$", line)
        if header:
            if section == "features":
                out.extend(f"\t{k} = true" for k in overrides if k not in seen)
            section = header[1].strip()
        if section == "features":
            match = re.match(r"^(\s*)(\w+)\s*=", line)
            if match and match[2] in overrides:
                out.append(f"{match[1]}{match[2]} = true")
                seen.add(match[2])
                continue
        out.append(line)
    if section == "features":
        out.extend(f"\t{k} = true" for k in overrides if k not in seen)
    if "features" not in data:
        out += ["", "[features]"] + [f"\t{k} = true" for k in overrides]
    result = "\n".join(out) + "\n"
    changed = tomllib.loads(result)
    expected = dict(data)
    expected["features"] = {**data.get("features", {}), **overrides}
    if changed != expected:
        raise ValueError("Refusing unexpected Synapse configuration changes")
    return result


def plan(game, enable_video=False):
    game = Path(game).resolve(strict=True)
    client = game / "config/xaero/minimap/client.cfg"
    match = re.search(r"^current_profile\s*=\s*([A-Za-z0-9_-]+)\s*$", client.read_text(), re.MULTILINE)
    if not match:
        raise ValueError("Cannot identify the current Xaero minimap profile")
    minimap = game / "config/xaero/minimap/profiles" / f"{match[1]}.cfg"
    options = game / "options.txt"
    synapse = game / "config/synapse-client.toml"
    hud = setting(minimap.read_text(), "display_minimap", "false")
    # Death markers clutter the resident's view and the stream; the body already
    # reports each death's coordinates. Older profiles may lack these keys.
    for key in ("deathpoints", "old_deathpoints"):
        if re.search(r"^\s*" + key + r"\s*=", hud, re.MULTILINE):
            hud = setting(hud, key, "false")
    return {
        options: profile.apply_options(options.read_text(), HUD_OPTIONS),
        minimap: hud,
        synapse: synapse_features(synapse.read_text(), enable_video),
    }


def apply(game, enable_video=False, dry_run=False):
    game = Path(game).expanduser().resolve(strict=True)
    users = profile.processes_using(game)
    if users and not dry_run:
        raise ValueError(f"Client directory is in use by pids {users}; stop it first")
    edits = plan(game, enable_video)
    changed = [str(path.relative_to(game)) for path, content in edits.items() if path.read_text() != content]
    if not dry_run:
        for path, content in edits.items():
            if str(path.relative_to(game)) not in changed:
                continue
            if path.is_symlink():
                raise ValueError(f"Refusing a symlink configuration: {path}")
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".hud-", delete=False) as file:
                    temporary = Path(file.name)
                    file.write(content)
                    os.fchmod(file.fileno(), path.stat().st_mode & 0o777)
                os.replace(temporary, path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", type=Path, required=True)
    parser.add_argument("--enable-video", action="store_true", help="Enable the new authenticated Synapse framebuffer source")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        changes = apply(args.game, args.enable_video, args.dry_run)
    except (OSError, ValueError) as error:
        parser.exit(1, f"client-hud: {error}\n")
    print(("Would update: " if args.dry_run else "Updated: ") + (", ".join(changes) or "already configured"))


if __name__ == "__main__":
    main()
