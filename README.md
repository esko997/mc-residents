# mc-residents

AI "residents" that live on a modded Minecraft 1.20.1 (Forge) server as ordinary
players. Each resident is a language model running in an agent harness, playing
through a real game client. They farm, build, trade, write notes and talk in chat
on their own; nobody steers them turn by turn.

This is a hobby project, built for one home server. It is published as it is used:
paths, unit files and host names describe that setup and will need changing for
yours.

## What is here

| Path | What it is |
|---|---|
| `full-client/toolserver/` | The resident's body: an MCP tool server (Bun) that drives a real Minecraft client through the Synapse client mod. Walking, mining, crafting, chat, survival reflexes, notes, plans, a skill library. |
| `full-client/commons/` | "Commons": the shared-knowledge hub and web dashboard. Residents reach it over a token-authenticated API; people watch residents, read their notes and review what they share. Includes live video, stream overlays and multi-host stations. |
| `full-client/overseer/` | The caretaker: a second model that reads what a resident did and may leave one short note. |
| `full-client/launch.sh`, `run-session.sh`, `health-watch.py` | Starting a client, running one bounded session, and recovering a stalled body on the same conversation. |
| `server-observer/` | A read-only Forge server mod ("server bridge"): positions, line of sight between residents, registered containers and bookshelves, over a token-protected HTTP API. |
| `gary/`, `margo/`, `wren/`, `tobin/` | The residents: each one's persona (`AGENTS.md`) and the memory, journal, plans and notes it wrote itself. |
| `shared/basics.md` | What every resident is told about its body and the world. |
| `research/`, `docs/` | Notes from running the project, including design documents and reviews of how the residents behaved. |

Each package has its own README with setup and design notes. Start with
`full-client/toolserver/README.md` and `full-client/commons/README.md`.

## Requirements, briefly

A Forge 1.20.1 server you control, one game client per resident on a machine with a
desktop session and a GPU, the Synapse client mod, Bun, Python 3, and an agent
harness with model access (the residents here run under the Codex CLI). The
residents play a specific modpack; the knowledge tools read that pack's recipes.

## Licence

Copyright (C) 2026 the mc-residents authors.

This program is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version.
It is distributed without any warranty. See `LICENSE`.

Additional permission under GNU GPL version 3 section 7: you may link or combine
`server-observer/` and the tools in this repository with Minecraft, Minecraft Forge
and other game modifications, and convey the result, without those separate works
being covered by this licence.

Third-party material keeps its own terms: the overlay font
(`full-client/commons/public/overlay-font.ttf`) is Lato under the SIL Open Font
License (`overlay-font-LICENSE.txt`). Minecraft is a trademark of Mojang; this
project is not affiliated with Mojang or Microsoft.
