# Slim client profiles and capacity experiments

Nothing here has been measured yet. These helpers make a slimmer client possible and measurable. They do not promise a saving.

## What a profile changes

`client-profile.py derive` builds a **new** game directory from an existing one. Forge 1.20.1 and Connector always load `<gameDir>/mods`, so leaving mods out takes a separate directory. The source directory is only read:

- Jars are hard-linked (copied only when linking fails). Jars in the profile's optional groups are left out. Groups are matched by the mod ids in each jar's `mods.toml`/`fabric.mod.json`, never by file name. Derive refuses if a kept jar declares a mandatory dependency on a removed mod, if a group matches nothing, or if a removed jar also contains other mods.
- Everything else is copied, so mod configs stay identical: config, options, servers.dat and the rest. Logs, crash reports, screenshots, saves and Xaero map caches are not copied. Copies over 512 MiB are refused.
- `options.txt` gets the profile's overrides. Synapse gets a fixed port with `autoPort = false`, so a port clash fails loudly and cannot bind a neighbour's port.
- A `.client-profile.json` marker records exactly what was changed.

| Profile | Options | Mods left out |
|---|---|---|
| `baseline` | none | none (control arm: same copy procedure, own port) |
| `options` | slim options | none |
| `visual` | slim options | shaders (Oculus), weather particles (Particle Rain, Visuality), connected textures (Continuity), Sound Physics Remastered |
| `visual-nomap` | slim options | as `visual`, plus Xaero minimap/world map and `ftbxaerocompat` (its required mixins target Xaero classes) |

The slim options are: `graphicsMode 0`, `particles 2`, `enableVsync false`, `maxFps 20`, `entityDistanceScaling 0.5`, `mipmapLevels 0`, `biomeBlendRadius 0`, `ao false`, `renderClouds "false"`, `entityShadows false`, `soundCategory_master 0.0` and `pauseOnLostFocus false`. The disposable Inspiron options already had the first five, so most of the difference is mipmaps, biome blend, smooth lighting and the mods.

Deliberately unchanged:

- **GUI scale.** Mod screens must stay readable in pictures.
- **Render distance.** It bounds the chunks the client holds, and with them Baritone's horizon and `find_block`/`mine` (radius 32, max 96; render distance 4 covers 64 blocks). Pass `--render-distance N` only as its own experiment arm.
- **Heap, cgroup limits, CPU quotas.** Profiles never touch them, and no memory caps are restored. To test a heap size, set `GARY_CLIENT_HEAP` for that disposable identity explicitly; the run's plan records it.
- **Resolution.** It mainly sizes the GPU framebuffer, not the Java heap. `GARY_CLIENT_RESOLUTION` is optional, defaults to 854x480 and refuses anything below 640x480: smaller windows force GUI scale 1, and the Commons view assumes 854x480.

AdLods is **not** a visual mod: it is "Large Ore Deposits" (worldgen data), so it stays.

## Launch wiring

`launch.sh` behaves exactly as before unless the game directory holds a profile marker or `GARY_CLIENT_PROFILE` is set. If either is present, it runs `$base/tools/client-profile.py launch-check` (override with `GARY_CLIENT_PROFILE_TOOL`) before every start. The check re-applies the options (the game rewrites `options.txt`) and re-pins the Synapse port. It refuses to start when removed jars are back, or when `GARY_CLIENT_PROFILE` names a different profile or a non-derived directory.

To undo a profile, point `GAME_DIR` back at the original directory. Delete a derived directory only by hand, after reading its logs.

## Disposable experiment

Example instance file, `instances/slim_a.env`:

```
GAME_DIR=/home/swatson/gary-client/game-slim-a
SYNAPSE_URL=http://127.0.0.1:25631
GARY_CLIENT_PROFILE=visual
```

1. With every client stopped, derive one directory per disposable identity and arm from the disposable source (`game-test`):

   ```
   tools/client-profile.py derive --source ~/gary-client/game-test --dest ~/gary-client/game-slim-a --profile visual --synapse-port 25631
   ```

2. The identities must be whitelisted and placed safely on the server; the tools do not do this. Choosing new disposable names is the operator's decision.
3. Run the experiment:

   ```
   tools/client-capacity.py run --clients slim_a,slim_b --out ~/capacity/2x-visual
   tools/client-capacity.py run --clients slim_a,slim_b,slim_c --out ~/capacity/3x-visual
   tools/client-capacity.py compare ~/capacity/2x-baseline/summary.json ~/capacity/2x-visual/summary.json ~/capacity/3x-visual/summary.json
   ```

`run` refuses in any of these cases: a resident identity (Gary, Margo, any `resident/<name>/AGENTS.md`, `RESIDENT_IDENTITIES`); a resident game directory or port; a directory not made by `derive`; shared ports or directories; or any `gary-run`/`margo-run`/`overseer-run` or `gary-client@*` unit already up.

The run itself:

- Clients start one at a time through `gary-client@<name>`, the same unit, CPU quota and slice the residents use.
- Each client must have at least 4 GiB `MemAvailable` before it starts and must reach the world within the ready timeout.
- The run samples warmup and measurement windows. The run aborts if `MemAvailable` stays under 1 GiB, or memory "full" pressure stays at or above 10, for two samples in a row, or if a client exits.
- Every client it started is stopped in `finally`, even if an earlier stop failed, and each one's final unit state is recorded.
- Exit codes: 0 means completed and every started unit was confirmed inactive or failed. 3 means aborted or interrupted, with cleanup confirmed. 4 means a stop failed or a unit is still active or in an unknown state; `summary.json` then has `cleanup_ok: false` and `cleanup_failures`, and the remaining clients must be stopped by hand before anything else.

Probes are only `GET /state` and an optional `GET /screenshot`, which checks that pictures still come back at the expected size. No world action is ever sent. Idle clients undercount walking, chunk-loading and pathing peaks, so run the functional rows (F1–F12 in `research/2026-11-22-resident-scaling.md`) on the slim arm separately.

Recorded per client: cgroup `memory.current`/`memory.peak`/anon, PSS/RSS/swap summed over the unit's processes, CPU % of one core, NVIDIA per-process memory (when the driver reports it), and bytes on the server connection (`ss`). Recorded per host: `MemAvailable`, swap, PSI memory/cpu/io (avg10 and share of the window stalled), swap-in/out, major faults, oom kills, and GPU memory/utilisation.

## Stage 0 sampling of a real run

`client-capacity.py sample` only reads; Synapse probes are opt-in:

```
tools/client-capacity.py sample --target Gary=gary-client@Gary.service --target Margo=gary-client@Margo.service \
  --target gary-mind=gary-run.service --target margo-mind=margo-run.service --duration 3600 --interval 60 --out ~/capacity/stage0.jsonl
```

## Tests

```
python3 -m unittest discover -s full-client/tools -p 'test_client_*.py' -v
```

## Inspiron result — 2026-11-22

The `visual` profile joined the real server and passed the separate navigation,
rescue, vehicle and machine scenarios on an isolated server. It retained the
minimap and readable 854×480 screenshots. No resident's profile was switched.

Two single-client arms used the same stationary creative location, 4 GiB heap,
render distance 4, 60-second warmup and a nominal 90-second measurement window
(nine samples spanning 80 seconds). These are short idle comparisons, not a
prediction of active gameplay:

| Metric | Baseline | Visual |
|---|---:|---:|
| Mean process PSS | 5,290 MiB | 5,216 MiB |
| Peak client-unit memory | 5,359 MiB | 5,283 MiB |
| Mean CPU, percent of one core | 76.9% | 66.4% |
| Per-client NVIDIA memory | 109 MiB | 109 MiB |

The observed PSS difference was only 74 MiB (about 1.4%); it does not establish a
repeatable saving. Removing these five visual/audio mods did not buy another
resident's worth of memory.

The three-visual-client attempt reached three server logins, but stopped during
startup: available host memory fell below the unchanged 1 GiB floor for two
samples, reaching 799,564 KiB (about 781 MiB). The third body's API had not yet
become healthy, and there was no three-client measurement window. No OOM kill
occurred; all three test units were confirmed inactive and all four temporary
whitelist entries and instance configurations were removed. Inert test-player
records remain; no permanent resident was created.

This is not a hardware ceiling, but it is not evidence for a safe three-resident
deployment either. Keep the demonstrated two-resident configuration; another
host or a separately tested larger reduction is preferable to removing the
experiment's guard. Resident runtime memory limits remain disabled.

Evidence: `~/.cache/minecraft-review/2026-11-22/capacity-evidence/` contains the
three summaries and samples. The earlier unpositioned baseline is retained
separately and excluded from this comparison. Network-byte sampling was
unavailable (`ss` absent); server MSPT and model-process memory were not measured.
