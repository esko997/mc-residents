#!/usr/bin/env python3
"""Opt-in slim client profiles, applied only to a DERIVED game directory.

Forge 1.20.1 (FMLPaths.MODSDIR) and Connector always scan <gameDir>/mods, so a
profile that leaves mods out needs its own game directory. `derive` builds one
next to the source: the source's jars are hard-linked (copied if linking is
impossible) except those of the selected optional groups, the rest of the
directory is copied, options.txt gets the profile's overrides and Synapse gets
its own fixed port. The source directory is never written. Undo = point
GAME_DIR back at the source; the derived directory can be inspected and then
removed by hand.

    client-profile.py list
    client-profile.py inspect --mods ~/gary-client/game-test/mods
    client-profile.py derive --source ~/gary-client/game-test --dest ~/gary-client/game-slim1 \
        --profile visual --synapse-port 25631 [--render-distance 3]
    client-profile.py show --game ~/gary-client/game-slim1
    client-profile.py launch-check --game "$GAME_DIR" [--expect visual]   # called by launch.sh

None of this changes Java heap, cgroup limits or the launch resolution, and no
memory saving is claimed: client-capacity.py measures each profile.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import zipfile

MARKER = ".client-profile.json"
SCHEMA = 1
SYNAPSE_CONFIG = Path("config") / "synapse-client.toml"

# Values as Minecraft 1.20.1 writes them to options.txt. renderDistance is
# deliberately absent: it bounds the chunks the client holds, so it also bounds
# Baritone's planning horizon and find_block/mine radius (mine defaults to 32
# blocks, max 96; render distance 4 is 64 blocks). It is an explicit
# --render-distance choice, never a profile default.
SLIM_OPTIONS = {
    "graphicsMode": "0",          # fast
    "particles": "2",             # minimal
    "enableVsync": "false",
    "maxFps": "20",               # same as the resident launch policy; Synapse main-thread work runs per frame
    "entityDistanceScaling": "0.5",
    "mipmapLevels": "0",          # no mip chains for the large modded texture atlas
    "biomeBlendRadius": "0",      # cheaper chunk meshing
    "ao": "false",                # smooth lighting off: cheaper chunk meshing, flatter pictures
    "renderClouds": '"false"',
    "entityShadows": "false",
    "soundCategory_master": "0.0",  # residents cannot hear; vanilla skips zero-volume sounds
    "pauseOnLostFocus": "false",  # an unfocused client must keep ticking
}

# Optional client-side mods, removed only when a profile names their group.
# Matched by the mod ids each jar declares, never by file name.
GROUPS = {
    "shaders": {
        "mods": ["oculus"],
        "note": "Shader loader. Residents' pictures do not use shader packs.",
    },
    "weather-particles": {
        "mods": ["particlerain", "visuality"],
        "note": "Decorative weather and ambient particles.",
    },
    "connected-textures": {
        "mods": ["continuity"],
        "note": "Connected glass/bookshelf textures (Fabric mod through Connector); blocks keep plain textures.",
    },
    "sound-physics": {
        "mods": ["sound_physics_remastered"],
        "note": "Sound reverb/occlusion. Residents cannot hear; matters only if sounds are audible.",
    },
    "xaero-maps": {
        "mods": ["xaerominimap", "xaeroworldmap", "ftbxaerocompat"],
        "note": "Removes the minimap residents can see in pictures (Margo's notes have used it). "
                "ftbxaerocompat ships required mixins into Xaero classes, so it must leave with them.",
    },
}

PROFILES = {
    "baseline": {
        "description": "Unchanged copy with its own Synapse port: the like-for-like control arm.",
        "options": {},
        "groups": [],
    },
    "options": {
        "description": "Low-cost render options only; every mod kept.",
        "options": SLIM_OPTIONS,
        "groups": [],
    },
    "visual": {
        "description": "Low-cost options and no decorative client mods; the minimap stays.",
        "options": SLIM_OPTIONS,
        "groups": ["shaders", "weather-particles", "connected-textures", "sound-physics"],
    },
    "visual-nomap": {
        "description": "As visual, and without Xaero's minimap/world map (residents lose the minimap in pictures).",
        "options": SLIM_OPTIONS,
        "groups": ["shaders", "weather-particles", "connected-textures", "sound-physics", "xaero-maps"],
    },
}

# Top-level entries of a game directory that describe one client's past, not
# its configuration. Everything else is copied so mod configs stay identical.
NOT_COPIED = {"mods", "logs", "crash-reports", "screenshots", "saves", "debug",
              "XaeroWorldMap", "XaeroWaypoints", ".fabric", MARKER}

DEFAULT_MAX_COPY_BYTES = 512 * 1024 * 1024


class ProfileError(Exception):
    pass


# ---------------------------------------------------------------- jar metadata

def _forge_requirements(data):
    required = set()
    deps = data.get("dependencies", {})
    if not isinstance(deps, dict):
        return required
    for entries in deps.values():
        if not isinstance(entries, list):
            continue
        for dep in entries:
            if not isinstance(dep, dict) or not isinstance(dep.get("modId"), str):
                continue
            mandatory = dep.get("mandatory") is True or str(dep.get("type", "")).lower() == "required"
            if mandatory and str(dep.get("side", "BOTH")).upper() != "SERVER":
                required.add(dep["modId"])
    return required


def _forge_fallback(text):
    """Some mods.toml files are not valid TOML. Read ids by line and treat every
    other mentioned modId as required, so a removal can only be refused, never
    wrongly allowed."""
    ids, mentioned = [], set()
    section = None
    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip()
        if stripped.startswith("["):
            section = stripped
            continue
        match = re.match(r'modId\s*=\s*"([^"]+)"', stripped)
        if match:
            if section == "[[mods]]":
                ids.append(match.group(1))
            else:
                mentioned.add(match.group(1))
    return ids, mentioned - set(ids)


def jar_metadata(path):
    """Mod ids a jar declares and the mod ids it cannot load without."""
    result = {"jar": Path(path).name, "ids": [], "requires": [], "loader": None, "error": None}
    requires = set()
    try:
        with zipfile.ZipFile(path) as jar:
            names = set(jar.namelist())
            if "META-INF/mods.toml" in names:
                result["loader"] = "forge"
                text = jar.read("META-INF/mods.toml").decode("utf-8", "replace")
                try:
                    import tomllib
                    data = tomllib.loads(text)
                    mods = data.get("mods", [])
                    result["ids"] += [m["modId"] for m in mods if isinstance(m, dict) and isinstance(m.get("modId"), str)]
                    requires |= _forge_requirements(data)
                except Exception as error:  # invalid TOML or no tomllib
                    ids, mentioned = _forge_fallback(text)
                    result["ids"] += ids
                    requires |= mentioned
                    result["error"] = f"mods.toml read line by line ({type(error).__name__}); all mentioned modIds treated as required"
            if "fabric.mod.json" in names:
                result["loader"] = result["loader"] or "fabric"
                try:
                    data = json.loads(jar.read("fabric.mod.json").decode("utf-8", "replace"), strict=False)
                    if isinstance(data.get("id"), str):
                        result["ids"].append(data["id"])
                    depends = data.get("depends", {})
                    if isinstance(depends, dict):
                        requires |= {k for k in depends if isinstance(k, str)}
                except (ValueError, AttributeError) as error:
                    result["error"] = f"fabric.mod.json unreadable: {error}"
    except (OSError, zipfile.BadZipFile) as error:
        result["error"] = f"not a readable jar: {error}"
    result["requires"] = sorted(requires - set(result["ids"]))
    return result


def scan_mods(mods_dir):
    mods_dir = Path(mods_dir)
    if not mods_dir.is_dir():
        raise ProfileError(f"{mods_dir} is not a directory")
    return [jar_metadata(p) for p in sorted(mods_dir.iterdir()) if p.suffix == ".jar" and p.is_file()]


def plan_exclusions(jars, group_names):
    """Jars to leave out for the selected groups, or ProfileError when a group
    matches nothing or a kept jar requires a removed mod."""
    problems, excluded, removed_ids, matched = [], [], set(), {}
    for group in group_names:
        if group not in GROUPS:
            raise ProfileError(f"unknown mod group {group!r}; known: {', '.join(GROUPS)}")
        wanted = set(GROUPS[group]["mods"])
        hits = [j for j in jars if wanted & set(j["ids"])]
        if not hits:
            problems.append(f"group {group}: none of {sorted(wanted)} is in the source mods "
                            "(run `inspect` and correct the mod ids)")
        for jar in hits:
            if any(jar is e["meta"] for e in excluded):
                continue
            extra = set(jar["ids"]) - wanted
            if extra:
                problems.append(f"group {group}: {jar['jar']} also contains {sorted(extra)}; refusing to remove it")
                continue
            excluded.append({"group": group, "jar": jar["jar"], "mod_ids": sorted(jar["ids"]), "meta": jar})
            removed_ids |= set(jar["ids"])
        matched[group] = sorted({i for j in hits for i in j["ids"]} & wanted)
    excluded_jars = {e["jar"] for e in excluded}
    for jar in jars:
        if jar["jar"] in excluded_jars:
            continue
        needed = removed_ids & set(jar["requires"])
        if needed:
            problems.append(f"{jar['jar']} requires removed mod(s) {sorted(needed)}")
    if problems:
        raise ProfileError("; ".join(problems))
    for entry in excluded:
        entry.pop("meta")
    return excluded, matched


# ---------------------------------------------------------------- options/config files

def apply_options(text, overrides):
    """Replace or append `key:value` lines; every other line stays as it was."""
    lines = text.splitlines()
    seen = set()
    for i, line in enumerate(lines):
        key = line.split(":", 1)[0]
        if ":" in line and key in overrides:
            lines[i] = f"{key}:{overrides[key]}"
            seen.add(key)
    lines += [f"{k}:{v}" for k, v in overrides.items() if k not in seen]
    return "\n".join(lines) + "\n"


def set_synapse_port(text, port):
    """Pin [server] port and disable autoPort: a busy port must fail loudly,
    never silently bind a neighbour while SYNAPSE_URL points elsewhere."""
    out, section, done = [], None, set()
    lines = text.splitlines()
    for line in lines:
        stripped = line.strip()
        header = re.match(r"^\[([^\]]+)\]\s*$", stripped)
        if header:
            if section == "server":
                out += _missing_server_keys(done, port)
            section = header.group(1).strip()
        elif section == "server":
            key = re.match(r"^(\s*)(port|autoPort)\s*=", line)
            if key:
                indent, name = key.group(1), key.group(2)
                out.append(f"{indent}{name} = {port if name == 'port' else 'false'}")
                done.add(name)
                continue
        out.append(line)
    if section == "server":
        out += _missing_server_keys(done, port)
    if "port" not in done and "[server]" not in (l.strip() for l in lines):
        out += ["", "[server]", f"\tport = {port}", "\tautoPort = false"]
    return "\n".join(out) + "\n"


def _missing_server_keys(done, port):
    added = []
    if "port" not in done:
        added.append(f"\tport = {port}")
        done.add("port")
    if "autoPort" not in done:
        added.append("\tautoPort = false")
        done.add("autoPort")
    return added


def read_synapse_port(text):
    section, port, auto = None, None, None
    for line in text.splitlines():
        stripped = line.split("#", 1)[0].strip()
        header = re.match(r"^\[([^\]]+)\]$", stripped)
        if header:
            section = header.group(1).strip()
        elif section == "server":
            match = re.match(r"^(port|autoPort)\s*=\s*(\S+)$", stripped)
            if match and match.group(1) == "port":
                port = int(match.group(2))
            elif match:
                auto = match.group(2).lower() == "true"
    return port, auto


def _write_atomic(path, text):
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    tmp.write_text(text)
    os.replace(tmp, path)


# ---------------------------------------------------------------- derive

def processes_using(game_dir, proc=Path("/proc")):
    """PIDs whose command line names this game directory as an argument."""
    target = str(Path(game_dir).resolve())
    users = []
    own_pid = str(os.getpid())
    for entry in proc.iterdir():
        if not entry.name.isdigit() or entry.name == own_pid:
            continue
        try:
            args = (entry / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        for arg in args:
            text = arg.decode("utf-8", "replace")
            if text == target or text.rstrip("/") == target or text.endswith("=" + target):
                users.append(int(entry.name))
                break
    return users


def _tree_size(path):
    if path.is_symlink() or path.is_file():
        return path.lstat().st_size
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def derive(source, dest, profile, synapse_port, render_distance=None,
           max_copy_bytes=DEFAULT_MAX_COPY_BYTES, proc=Path("/proc")):
    source, dest = Path(source).expanduser().resolve(), Path(dest).expanduser().absolute()
    if profile not in PROFILES:
        raise ProfileError(f"unknown profile {profile!r}; known: {', '.join(PROFILES)}")
    if not 1024 <= synapse_port <= 65535:
        raise ProfileError("synapse port must be 1024-65535")
    if render_distance is not None and not 2 <= render_distance <= 32:
        raise ProfileError("render distance must be 2-32")
    if not (source / "mods").is_dir():
        raise ProfileError(f"{source} has no mods directory")
    if (source / MARKER).exists():
        raise ProfileError(f"{source} is itself a derived profile directory; derive from the original")
    if dest.exists() or dest.is_symlink():
        raise ProfileError(f"{dest} already exists; choose a new directory")
    if not dest.parent.is_dir():
        raise ProfileError(f"{dest.parent} does not exist")
    if dest.resolve() == source or source in dest.resolve().parents or dest.resolve() in source.parents:
        raise ProfileError("destination must be outside the source and must not contain it")
    users = processes_using(source, proc)
    if users:
        raise ProfileError(f"a client is using {source} (pids {users}); stop it before deriving")
    synapse_config = source / SYNAPSE_CONFIG
    if not synapse_config.is_file():
        raise ProfileError(f"{synapse_config} missing: start the source client once so Synapse writes its config")

    spec = PROFILES[profile]
    jars = scan_mods(source / "mods")
    excluded, matched = plan_exclusions(jars, spec["groups"])
    unreadable = [j["jar"] + ": " + j["error"] for j in jars if j["error"]]
    excluded_names = {e["jar"] for e in excluded}

    copies = [p for p in sorted(source.iterdir()) if p.name not in NOT_COPIED]
    sizes = {p.name: _tree_size(p) for p in copies}
    if sum(sizes.values()) > max_copy_bytes:
        largest = sorted(sizes.items(), key=lambda kv: -kv[1])[:5]
        raise ProfileError(f"copy would be {sum(sizes.values())} bytes (limit {max_copy_bytes}); largest: {largest}")

    options = dict(spec["options"])
    if render_distance is not None:
        options["renderDistance"] = str(render_distance)

    partial = dest.with_name(f".{dest.name}.partial-{os.getpid()}")
    linked = copied = skipped = 0
    try:
        (partial / "mods").mkdir(parents=True)
        for entry in sorted((source / "mods").iterdir()):
            if entry.suffix != ".jar" or not entry.is_file():
                skipped += 1  # Connector caches, configs and disabled jars stay behind
                continue
            if entry.name in excluded_names:
                continue
            target = partial / "mods" / entry.name
            try:
                os.link(entry.resolve(), target)
                linked += 1
            except OSError:
                shutil.copy2(entry, target)
                copied += 1
        for item in copies:
            if item.is_dir() and not item.is_symlink():
                shutil.copytree(item, partial / item.name, symlinks=True)
            else:
                shutil.copy2(item, partial / item.name, follow_symlinks=False)
        if options:
            opts = partial / "options.txt"
            _write_atomic(opts, apply_options(opts.read_text() if opts.exists() else "", options))
        cfg = partial / SYNAPSE_CONFIG
        _write_atomic(cfg, set_synapse_port(cfg.read_text(), synapse_port))
        marker = {
            "schema": SCHEMA,
            "profile": profile,
            "description": spec["description"],
            "source": str(source),
            "created_at": int(time.time()),
            "options": options,
            "render_distance": render_distance,
            "synapse_port": synapse_port,
            "excluded": excluded,
            "groups": {g: {"matched_mod_ids": matched.get(g, []), "note": GROUPS[g]["note"]} for g in spec["groups"]},
            "jars_kept": len(jars) - len(excluded),
            "unreadable_metadata": unreadable,
        }
        _write_atomic(partial / MARKER, json.dumps(marker, indent=2) + "\n")
        os.rename(partial, dest)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)  # only the directory this call created
        raise
    return {**marker, "game_dir": str(dest), "mods_hardlinked": linked, "mods_copied": copied,
            "mods_dir_entries_skipped": skipped, "copied_bytes": sum(sizes.values())}


# ---------------------------------------------------------------- launch

def load_marker(game):
    path = Path(game) / MARKER
    if not path.exists():
        return None
    marker = json.loads(path.read_text())
    if marker.get("schema") != SCHEMA or marker.get("profile") not in PROFILES:
        raise ProfileError(f"{path}: unsupported profile marker")
    return marker


def launch_check(game, expect=None):
    """Called by launch.sh before every start of a derived directory. Re-applies
    options (the game rewrites options.txt), re-pins Synapse's port and refuses
    a directory whose removed jars came back or whose profile is not the one the
    instance asked for."""
    game = Path(game)
    marker = load_marker(game)
    if marker is None:
        if expect:
            raise ProfileError(f"GARY_CLIENT_PROFILE={expect} but {game} is not a derived profile directory "
                               "(client-profile.py derive); refusing to start the unslimmed client")
        return None
    if expect and expect != marker["profile"]:
        raise ProfileError(f"GARY_CLIENT_PROFILE={expect} but {game} holds profile {marker['profile']}")
    back = [e["jar"] for e in marker["excluded"] if (game / "mods" / e["jar"]).exists()]
    if back:
        raise ProfileError(f"removed jars are back in {game / 'mods'}: {back}")
    notes = []
    if marker["options"]:
        opts = game / "options.txt"
        before = opts.read_text() if opts.exists() else ""
        after = apply_options(before, marker["options"])
        if after != before:
            _write_atomic(opts, after)
            notes.append("options re-applied")
    cfg = game / SYNAPSE_CONFIG
    if not cfg.is_file():
        raise ProfileError(f"{cfg} missing")
    port, auto = read_synapse_port(cfg.read_text())
    if port != marker["synapse_port"] or auto is not False:
        _write_atomic(cfg, set_synapse_port(cfg.read_text(), marker["synapse_port"]))
        notes.append("synapse port re-pinned")
    return {"profile": marker["profile"], "synapse_port": marker["synapse_port"],
            "excluded": len(marker["excluded"]), "notes": notes}


# ---------------------------------------------------------------- CLI

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="profiles and mod groups")
    p = sub.add_parser("inspect", help="mod ids and hard requirements per jar")
    p.add_argument("--mods", required=True)
    p = sub.add_parser("derive", help="build a new game directory for a profile")
    p.add_argument("--source", required=True)
    p.add_argument("--dest", required=True)
    p.add_argument("--profile", required=True, choices=sorted(PROFILES))
    p.add_argument("--synapse-port", type=int, required=True)
    p.add_argument("--render-distance", type=int)
    p.add_argument("--max-copy-bytes", type=int, default=DEFAULT_MAX_COPY_BYTES)
    p = sub.add_parser("show", help="print a derived directory's profile")
    p.add_argument("--game", required=True)
    p = sub.add_parser("launch-check", help="used by launch.sh")
    p.add_argument("--game", required=True)
    p.add_argument("--expect")
    args = parser.parse_args(argv)
    try:
        if args.command == "list":
            out = {"profiles": PROFILES, "groups": GROUPS}
        elif args.command == "inspect":
            out = scan_mods(Path(args.mods).expanduser())
        elif args.command == "derive":
            out = derive(args.source, args.dest, args.profile, args.synapse_port,
                         args.render_distance, args.max_copy_bytes)
        elif args.command == "show":
            out = load_marker(Path(args.game).expanduser())
            if out is None:
                raise ProfileError(f"{args.game} is not a derived profile directory")
        else:
            result = launch_check(Path(args.game).expanduser(), args.expect or None)
            if result:
                print(f"client profile {result['profile']}: {result['excluded']} jar(s) left out, "
                      f"synapse port {result['synapse_port']}"
                      + (f", {', '.join(result['notes'])}" if result["notes"] else ""), file=sys.stderr)
            return 0
    except (ProfileError, OSError, ValueError) as error:
        print(f"client-profile: {error}", file=sys.stderr)
        return 2
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
