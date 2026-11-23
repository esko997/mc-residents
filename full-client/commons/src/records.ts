// Records for a historian (hub only): what the hub actually holds, dated, with where each line comes from.
// Sources and how sure they are:
//   [server]  the game server recorded it (server bridge: online/offline, dimension changes, deaths, statistics,
//             advancements, block changes, container counts);
//   [hub]     the hub received it when it happened (alarms, registrations, agreement steps), from a resident;
//             what such a record SAYS is that resident's word;
//   [chat]    said or announced in the game's public chat, kept only in the hub's recent console ring.
// Never read here: residents' private notes, plans, journals, positions trails, or another pair's named
// agreements; and nothing about people beyond the public chat lines residents could have seen.
import type { Database } from "bun:sqlite";
import { classify, type ConsoleLine } from "./console.ts";
import { recordsArgs, type RecordKind, type RecordsArgs } from "./resident-contracts-library.ts";

export interface RecordsDeps {
  now?: () => number;
  /** The hub console's lines, oldest first (a memory ring, see console.ts). */
  chat?: () => ConsoleLine[];
  /** Every credentialed resident's name. */
  residents?: () => string[];
  /** Players nobody perceives (the owner's spectator); lines naming them are left out. */
  unseen?: readonly string[];
}

interface Line { at: number; text: string }
const HOUR = 3_600_000, DAY = 24 * HOUR, PAGE_CHARS = 1100, MAX_LINES = 400;
const stamp = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const clock = (at: number) => new Date(at).toISOString().slice(11, 16);
const iso = (at: number) => new Date(at).toISOString();
const short = (id: string) => id.replace(/^minecraft:/, "");
const number = (value: number) => value.toLocaleString("en-US");
function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Public chat as players see it: someone speaking, the server announcing, or a player event; never whispers or tellraw. */
const SPOKEN = /^(?:\[Not Secure\] )?(?:<(\w{1,16})> |\[Server\] |\* (\w{1,16}) )/;
const DEATH = /^(\w{1,16}) (?!joined the game|left the game|has made the advancement|has completed the challenge|has reached the goal|lost connection)/;
/** Player events every player sees in chat; "lost connection" and login lines are server-log only (they carry addresses). */
const ANNOUNCED = /^\w{1,16} (?:joined the game$|left the game$|has made the advancement \[|has completed the challenge \[|has reached the goal \[)/;

export function createRecords(db: Database, resident: string, deps: RecordsDeps = {}) {
  const now = deps.now ?? Date.now;
  const unseen = (deps.unseen ?? []).map(name => name.toLowerCase());
  const mentionsUnseen = (text: string) => unseen.length > 0 && (text.toLowerCase().match(/\w+/g) ?? []).some(word => unseen.includes(word));
  const residents = () => deps.residents?.() ?? [];
  const sameName = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();

  return (input: RecordsArgs): string => {
    const a = recordsArgs.parse(input);
    const until = a.until ?? now(), since = a.since ?? until - DAY;
    if (since >= until) throw new Error("since must be before until.");
    const who = a.resident, area = a.area;
    const inArea = (x: number, z: number, dimension: string) => !area || ((!area.dimension || area.dimension === dimension) && Math.hypot(x - area.x, z - area.z) <= area.radius);
    const notes: string[] = [];

    /** Who was online when, from the server's own online/offline events (and, before those, chat join/leave lines). */
    const presence = () => {
      const rows = db.query<{ at: number; type: string; resident: string }, [number]>(
        "SELECT at, type, resident FROM history_server_events WHERE type IN ('resident_online','resident_offline') AND at <= ? ORDER BY at").all(until);
      return rows;
    };

    const kinds: Record<Exclude<RecordKind, "summary">, () => Line[]> = {
      deaths() {
        const lines: Line[] = [];
        const events = db.query<{ at: number; resident: string; detail: string | null }, [number, number]>(
          "SELECT at, resident, detail FROM history_server_events WHERE type = 'resident_died' AND at >= ? AND at < ? ORDER BY at").all(since, until)
          .filter(row => !who || sameName(row.resident, who));
        const said = chatLines().filter(line => line.kind === "players" && DEATH.test(line.text));
        for (const event of events) {
          const cause = said.find(line => sameName(DEATH.exec(line.text)?.[1], event.resident) && Math.abs(line.t - event.at) <= 30_000);
          lines.push({ at: event.at, text: `${stamp(event.at)} ${event.resident} died${event.detail ? ` in ${event.detail}` : ""} [server]${cause ? `; chat said: "${cause.text}" [chat]` : ""}` });
        }
        for (const line of said) {
          const name = DEATH.exec(line.text)![1]!;
          if (who && !sameName(name, who)) continue;
          if (events.some(event => sameName(event.resident, name) && Math.abs(line.t - event.at) <= 30_000)) continue;
          lines.push({ at: line.t, text: `${stamp(line.t)} ${line.text} [chat]` });
        }
        // Deaths before the server's death events were kept: the statistic rises between two saves of the stats file.
        const counts = db.query<{ resident: string; saved_at: number; value: number }, [number, number]>(
          "SELECT resident, saved_at, value FROM server_stat_values WHERE type = 'minecraft:custom' AND key = 'minecraft:deaths' AND saved_at <= ? AND saved_at >= ? ORDER BY resident, saved_at")
          .all(until, since - 7 * DAY);
        for (let i = 1; i < counts.length; i++) {
          const before = counts[i - 1]!, after = counts[i]!;
          if (before.resident !== after.resident || after.saved_at < since || after.value <= before.value) continue;
          if (who && !sameName(after.resident, who)) continue;
          if (events.some(event => sameName(event.resident, after.resident) && event.at > before.saved_at && event.at <= after.saved_at + 60_000)) continue;
          lines.push({ at: after.saved_at, text: `between ${stamp(before.saved_at)} and ${clock(after.saved_at)} ${after.resident}'s death count rose ${before.value} -> ${after.value} [server statistics; exact time not recorded]` });
        }
        if (area) notes.push("Deaths carry no position in these records; the area was not applied.");
        return lines;
      },
      alarms() {
        return db.query<{ event_json: string; at: number }, [number, number]>("SELECT event_json, at FROM resident_alarms WHERE at >= ? AND at < ? ORDER BY at").all(since, until)
          .map(row => JSON.parse(row.event_json) as { sender: string; kind: string; reason: string; x: number; y: number; z: number; dimension: string; health?: number; maxHealth?: number; at: number })
          .filter(e => (!who || sameName(e.sender, who)) && inArea(e.x, e.z, e.dimension))
          .map(e => ({ at: e.at, text: `${stamp(e.at)} ${e.sender} ${e.kind === "auto" ? "alarm raised by their body" : "shouted"}: ${e.reason} at ${Math.floor(e.x)},${Math.floor(e.y)},${Math.floor(e.z)} ${e.dimension}${e.health !== undefined ? `, health ${e.health}/${e.maxHealth ?? 20}` : ""} [hub]` }));
      },
      agreements() {
        // Only the caller's own agreements and public invitations: a named agreement between others is theirs.
        const rows = db.query<{ id: number; kind: string; sender: string; recipient: string | null; project: string | null; status: string; revision: number; actor: string; action: string; detail: string; at: number }, [string, string, number, number]>(
          `SELECT c.id, c.kind, c.sender, c.recipient, c.project, c.status, h.revision, h.actor, h.action, h.detail, h.at FROM collaboration_history h JOIN collaborations c ON c.id = h.collaboration_id
           WHERE (c.sender = ? COLLATE NOCASE OR c.recipient = ? COLLATE NOCASE OR c.recipient IS NULL) AND h.at >= ? AND h.at < ? ORDER BY h.at, h.id`).all(resident, resident, since, until);
        notes.push("Only your own agreements and public ones are shown; others' named agreements are theirs to tell.");
        return rows.filter(r => !who || sameName(r.sender, who) || sameName(r.recipient, who) || sameName(r.actor, who)).map(r => ({
          at: r.at,
          text: `${stamp(r.at)} #${r.id} ${r.kind} ${r.sender} -> ${r.recipient ?? "anyone"}${r.project ? ` [${r.project}]` : ""}: ${r.actor} ${r.action}${r.action === "propose" || r.action === "counter" ? ` "${r.detail.slice(0, 120)}"` : r.action === "report" || r.action === "confirm" ? ` (${r.actor}'s word, not checked): ${r.detail.slice(0, 120)}` : ""} [hub]`,
        }));
      },
      facilities() {
        const made = db.query<{ id: number; name: string; purpose: string; steward: string; x: number; y: number; z: number; dimension: string; created_at: number }, [number, number]>(
          "SELECT id, name, purpose, steward, x, y, z, dimension, created_at FROM facilities WHERE created_at >= ? AND created_at < ? ORDER BY created_at").all(since, until)
          .filter(f => (!who || sameName(f.steward, who)) && inArea(f.x, f.z, f.dimension))
          .map(f => ({ at: f.created_at, text: `${stamp(f.created_at)} ${f.steward} registered facility #${f.id} "${f.name}" (${f.purpose.slice(0, 80)}) at ${Math.floor(f.x)},${Math.floor(f.y)},${Math.floor(f.z)} ${f.dimension} [hub; the steward's claim]` }));
        const seen = db.query<{ id: number; name: string; x: number; z: number; dimension: string; observer: string; condition: string; certainty: string; observed_at: number }, [number, number]>(
          `SELECT f.id, f.name, f.x, f.z, f.dimension, o.observer, o.condition, o.certainty, o.observed_at FROM facility_observations o JOIN facilities f ON f.id = o.facility_id
           WHERE o.observed_at >= ? AND o.observed_at < ? ORDER BY o.observed_at`).all(since, until)
          .filter(o => (!who || sameName(o.observer, who)) && inArea(o.x, o.z, o.dimension))
          .map(o => ({ at: o.observed_at, text: `${stamp(o.observed_at)} ${o.observer} on facility #${o.id} "${o.name}": ${o.condition.slice(0, 100)} [hub; ${o.observer}'s ${o.certainty} report]` }));
        return [...made, ...seen];
      },
      places() {
        notes.push("A shared place shows when it was last saved; earlier versions are not kept.");
        return db.query<{ name: string; author: string; data: string; updated_at: number }, [number, number]>(
          "SELECT name, author, data, updated_at FROM shared_places WHERE updated_at >= ? AND updated_at < ? ORDER BY updated_at").all(since, until)
          .map(row => ({ ...row, place: JSON.parse(row.data) as { x: number; y: number; z: number; dimension: string; note?: string } }))
          .filter(row => (!who || sameName(row.author, who)) && inArea(row.place.x, row.place.z, row.place.dimension))
          .map(row => ({ at: row.updated_at, text: `${stamp(row.updated_at)} ${row.author} saved shared place "${row.name}" at ${row.place.x},${row.place.y},${row.place.z} ${row.place.dimension}${row.place.note ? `: ${row.place.note.slice(0, 80)}` : ""} [hub]` }));
      },
      books() {
        // Each line gives the place the observation itself names: where the book stood at that time.
        const said: Record<string, (row: { observer: string; book: string; place: string }) => string> = {
          registered: r => `${r.observer} described book ${r.book} [hub]`,
          found: r => `${r.observer} reported book ${r.book}${r.place} [hub]`,
          missing: r => `${r.observer} reported book ${r.book} missing${r.place} [hub]`,
          server_seen: r => `the server saw book ${r.book}${r.place} [server]`,
          server_gone: r => `the server saw that book ${r.book} is no longer${r.place} [server]`,
          shelf_gone: r => `the server saw the shelf or lectern holding book ${r.book}${r.place} gone [server]`,
        };
        return db.query<{ id: number; kind: string; title: string | null; author: string | null; observer: string; x: number | null; y: number | null; z: number | null; dimension: string | null; note: string; at: number }, [number, number]>(
          `SELECT b.id, o.kind, b.title, b.author, o.observer, o.x, o.y, o.z, o.dimension, o.note, o.at FROM library_observations o JOIN library_books b ON b.id = o.book_id
           WHERE o.kind != 'edited' AND o.at >= ? AND o.at < ? ORDER BY o.at, o.id`).all(since, until)
          .filter(row => (!who || sameName(row.observer, who) || sameName(row.author, who)) && (!area || (row.x !== null && inArea(row.x, row.z!, row.dimension!))))
          .map(row => ({ at: row.at, text: `${stamp(row.at)} ${said[row.kind]!({
            observer: row.observer,
            book: `#${row.id} ${row.title === null ? "(an unsigned book and quill)" : `"${row.title}" by ${row.author}`}`,
            place: row.x === null ? "" : ` at ${row.x},${row.y},${row.z}${row.note ? ` (${row.note})` : ""}`,
          })}` }))
          .filter(line => !mentionsUnseen(line.text));
      },
      sessions() {
        const rows = presence();
        const lines: Line[] = [];
        const open = new Map<string, number>();
        const close = (name: string, end: number | undefined) => {
          const start = open.get(name)!;
          open.delete(name);
          if ((end ?? until) <= since || (who && !sameName(name, who))) return;
          lines.push({ at: start, text: `${name} online ${stamp(start)} -> ${end === undefined ? "still online" : stamp(end)}${end === undefined ? "" : ` (${span(end - start)})`} [server]` });
        };
        for (const row of rows) {
          if (row.type === "resident_online") { if (open.has(row.resident)) close(row.resident, row.at); open.set(row.resident, row.at); }
          else if (open.has(row.resident)) close(row.resident, row.at);
        }
        for (const name of [...open.keys()]) close(name, undefined);
        coverage("resident_online", "Sessions");
        return lines.filter(line => line.at < until);
      },
      crossings() {
        coverage("resident_dimension", "Dimension changes");
        return db.query<{ at: number; resident: string; detail: string | null }, [number, number]>(
          "SELECT at, resident, detail FROM history_server_events WHERE type = 'resident_dimension' AND at >= ? AND at < ? ORDER BY at").all(since, until)
          .filter(row => !who || sameName(row.resident, who))
          .map(row => ({ at: row.at, text: `${stamp(row.at)} ${row.resident} went ${row.detail ?? "to another dimension"} [server; how (portal, death, other) is not recorded]` }));
      },
      advancements() {
        const done = db.query<{ resident: string; id: string; done_at: number; title: string | null }, [number, number]>(
          `SELECT a.resident, a.id, a.done_at, c.title FROM server_advancements a LEFT JOIN server_advancement_catalog c ON c.id = a.id
           WHERE a.done = 1 AND a.done_at >= ? AND a.done_at < ? ORDER BY a.done_at`).all(since, until)
          .filter(row => !who || sameName(row.resident, who));
        return done.map(row => {
          const criteria = db.query<{ criterion: string; achieved_at: number | null }, [string, string]>(
            "SELECT criterion, achieved_at FROM server_advancement_criteria WHERE resident = ? AND id = ? ORDER BY achieved_at").all(row.resident, row.id);
          const listed = criteria.slice(0, 4).map(c => `${short(c.criterion)} ${c.achieved_at ? clock(c.achieved_at) : "time unknown"}`).join(", ");
          return { at: row.done_at, text: `${stamp(row.done_at)} ${row.resident} earned "${row.title ?? short(row.id)}" (${short(row.id)})${listed ? `; criteria met: ${listed}${criteria.length > 4 ? `, ${criteria.length - 4} more` : ""}` : ""} [server]` };
        });
      },
      stats() {
        const names = db.query<{ resident: string }, []>("SELECT DISTINCT resident FROM server_stat_latest ORDER BY resident").all().map(row => row.resident)
          .filter(name => !who || sameName(name, who));
        const lines: Line[] = [];
        for (const name of names) {
          const at = db.query<{ saved: number }, [string]>("SELECT MAX(saved_at) AS saved FROM server_stat_latest WHERE resident = ?").get(name)?.saved ?? until;
          const value = (type: string, key: string) => db.query<{ value: number }, [string, string, string]>(
            "SELECT value FROM server_stat_latest WHERE resident = ? AND type = ? AND key = ?").get(name, type, key)?.value ?? 0;
          const before = (type: string, key: string) => db.query<{ value: number }, [string, string, string, number]>(
            "SELECT value FROM server_stat_values WHERE resident = ? AND type = ? AND key = ? AND saved_at <= ? ORDER BY saved_at DESC LIMIT 1").get(name, type, key, since)?.value;
          const figure = (label: string, type: string, keys: string[], scale = 1, unit = "") => {
            const total = keys.reduce((sum, key) => sum + value(type, key), 0);
            if (!total) return undefined;
            const was = keys.map(key => before(type, key));
            const delta = was.every(v => v === undefined) ? undefined : total - was.reduce<number>((sum, v) => sum + (v ?? 0), 0);
            const show = (v: number) => scale === 1 ? number(v) : (v / scale).toFixed(1);
            return `${label} ${show(total)}${unit}${delta ? ` (+${show(delta)} since ${clock(since)})` : ""}`;
          };
          const custom = "minecraft:custom";
          const top = (type: string, label: string) => {
            const rows = db.query<{ key: string; value: number }, [string, string]>("SELECT key, value FROM server_stat_latest WHERE resident = ? AND type = ? ORDER BY value DESC LIMIT 3").all(name, type);
            return rows.length ? `${label} ${rows.map(row => `${short(row.key)} ${number(row.value)}`).join(", ")}` : undefined;
          };
          const parts = [
            figure("played", custom, ["minecraft:play_time"], 72_000, " h"), figure("died", custom, ["minecraft:deaths"]),
            figure("mobs killed", custom, ["minecraft:mob_kills"]), figure("animals bred", custom, ["minecraft:animals_bred"]),
            figure("walked", custom, ["minecraft:walk_one_cm", "minecraft:sprint_one_cm", "minecraft:crouch_one_cm"], 100_000, " km"),
            figure("swam", custom, ["minecraft:swim_one_cm", "minecraft:walk_under_water_one_cm"], 100_000, " km"),
            figure("rode", custom, ["minecraft:boat_one_cm", "minecraft:minecart_one_cm", "minecraft:horse_one_cm", "minecraft:pig_one_cm", "minecraft:strider_one_cm"], 100_000, " km"),
            figure("flew", custom, ["minecraft:aviate_one_cm", "minecraft:fly_one_cm"], 100_000, " km"),
            figure("slept", custom, ["minecraft:sleep_in_bed"]), figure("traded", custom, ["minecraft:traded_with_villager"]),
            figure("fish caught", custom, ["minecraft:fish_caught"]),
            top("minecraft:mined", "most mined:"), top("minecraft:crafted", "most crafted:"), top("minecraft:killed", "most killed:"),
          ].filter(Boolean);
          lines.push({ at, text: `${name}, as of the stats saved ${stamp(at)}: ${parts.join("; ") || "nothing recorded"} [server statistics; totals since the first day]` });
        }
        notes.push("Statistics are totals the server keeps for each player; they are saved about every five minutes.");
        return lines;
      },
      building() {
        const cells = db.query<{ resident: string; dimension: string; chunk_x: number; chunk_z: number; placed: number; broken: number; kinds: string; first: number; last: number }, [number, number]>(
          `SELECT resident, dimension, chunk_x, chunk_z, SUM(placed) AS placed, SUM(broken) AS broken, group_concat(kinds_json, char(10)) AS kinds, MIN(first_at) AS first, MAX(last_at) AS last
           FROM server_block_hours WHERE hour >= ? AND hour < ? GROUP BY resident, dimension, chunk_x, chunk_z`).all(Math.floor(since / HOUR) * HOUR, until)
          .filter(c => (!who || sameName(c.resident, who)) && inArea(c.chunk_x * 16 + 8, c.chunk_z * 16 + 8, c.dimension))
          .sort((x, y) => y.placed + y.broken - x.placed - x.broken).slice(0, 40);
        const lines = cells.map(c => {
          const totals = new Map<string, { placed: number; broken: number }>();
          for (const json of c.kinds.split("\n")) for (const kind of JSON.parse(json) as { block: string; placed: number; broken: number }[]) {
            const total = totals.get(kind.block) ?? { placed: 0, broken: 0 };
            total.placed += kind.placed; total.broken += kind.broken; totals.set(kind.block, total);
          }
          const most = (field: "placed" | "broken") => [...totals].filter(([, t]) => t[field]).sort((x, y) => y[1][field] - x[1][field]).slice(0, 3).map(([block, t]) => `${short(block)} ${t[field]}`).join(", ");
          const placed = most("placed"), broken = most("broken");
          return { at: c.first, text: `${clock(c.first)}-${clock(c.last)} ${c.resident} placed ${c.placed}, broke ${c.broken} in the chunk ${c.chunk_x * 16}..${c.chunk_x * 16 + 15}, ${c.chunk_z * 16}..${c.chunk_z * 16 + 15} (x, z) ${c.dimension}${placed ? `; placed most: ${placed}` : ""}${broken ? `; broke most: ${broken}` : ""} [server]` };
        });
        const overflow = db.query<{ n: number }, [number, number]>("SELECT SUM(placed + broken) AS n FROM server_block_overflow WHERE hour >= ? AND hour < ?").get(Math.floor(since / HOUR) * HOUR, until)?.n;
        if (overflow) notes.push(`${overflow} more block changes were counted without a place (the server's table was full).`);
        notes.push("Only blocks residents placed or broke by hand or tool; explosions, pistons, fluids and machines are not seen. Largest areas first, at most 40.");
        gaps(["blocks", "block_hours"]);
        return lines;
      },
      flows() {
        const facilities = new Map(db.query<{ id: number; name: string; x: number; z: number; dimension: string }, []>("SELECT id, name, x, z, dimension FROM facilities").all().map(f => [`facility-${f.id}`, f]));
        const rows = db.query<{ facility: string; at: number; since_at: number; deltas_json: string; uncertain_json: string; attribution: string; resident: string | null }, [number, number]>(
          "SELECT facility, at, since_at, deltas_json, uncertain_json, attribution, resident FROM server_container_flows WHERE at >= ? AND at < ? ORDER BY at").all(since, until);
        notes.push("Who changed a container is a guess from who stood within 8 blocks; hoppers, pipes and people are not seen.");
        gaps(["flows"]);
        return rows.filter(row => (!who || sameName(row.resident, who))).flatMap(row => {
          const facility = facilities.get(row.facility);
          if (facility && !inArea(facility.x, facility.z, facility.dimension)) return [];
          if (!facility && area) return [];
          const deltas = (JSON.parse(row.deltas_json) as { item: string; before: number; after: number }[]).map(d => `${d.after > d.before ? "+" : ""}${d.after - d.before} ${short(d.item)}`).join(", ");
          const uncertain = JSON.parse(row.uncertain_json) as string[];
          return [{ at: row.at, text: `${clock(row.since_at)}-${stamp(row.at)} ${facility ? `facility "${facility.name}"` : row.facility}: ${deltas}${uncertain.length ? ` (uncertain: ${uncertain.join(", ")})` : ""} [server counted it; ${row.resident ? `${row.resident} stood nearest (evidence, not proof)` : "no resident within reach"}]` }];
        });
      },
      said() {
        const lines = chatLines().filter(line => !who || line.text.toLowerCase().includes(who.toLowerCase()));
        notes.push("Chat is what the hub's console still holds (a ring of recent lines since its last restart); older talk is gone from these records.");
        return lines.map(line => ({ at: line.t, text: `${stamp(line.t)} ${line.text} [chat]` }));
      },
    };

    /** Public chat lines in the window that some resident could have seen: one of them was online. */
    function chatLines(): ConsoleLine[] {
      const lines = (deps.chat?.() ?? []).filter(line => line.t >= since && line.t < until && !line.noise && !line.mark
        && !line.text.includes("<Caretaker>") && !mentionsUnseen(line.text)
        && (SPOKEN.test(line.text) || (classify(line.text) === "players" && (ANNOUNCED.test(line.text) || DEATH.test(line.text)))));
      const online = presence(), names = residents().map(name => name.toLowerCase());
      // Fallback before the server's events were kept: join/leave lines in the console itself.
      const joins = (deps.chat?.() ?? []).flatMap(line => {
        const found = /^(\w{1,16}) (joined|left) the game$/.exec(line.text);
        return found && names.includes(found[1]!.toLowerCase()) ? [{ at: line.t, type: found[2] === "joined" ? "resident_online" : "resident_offline", resident: found[1]! }] : [];
      });
      // One sweep through presence changes and lines, both in time order.
      const changes = [...online, ...joins].sort((x, y) => x.at - y.at);
      const state = new Map<string, boolean>();
      let next = 0, dropped = 0;
      const heard = [...lines].sort((x, y) => x.t - y.t).filter(line => {
        for (; next < changes.length && changes[next]!.at <= line.t; next++) state.set(changes[next]!.resident.toLowerCase(), changes[next]!.type === "resident_online");
        if (line.source === "game" || [...state.values()].some(Boolean)) return true;
        dropped++; return false;
      });
      if (dropped) notes.push(`${dropped} chat line${dropped === 1 ? "" : "s"} from times no resident is known to have been online are left out.`);
      return heard;
    }
    function coverage(type: string, label: string) {
      const first = db.query<{ at: number | null }, [string]>("SELECT MIN(at) AS at FROM history_server_events WHERE type = ?").get(type)?.at;
      notes.push(first ? `${label} are recorded since ${stamp(first)}.` : `${label}: the hub has none recorded yet (kept since the server bridge's events were first stored).`);
    }
    function gaps(kinds: string[]) {
      const rows = db.query<{ kind: string; n: number }, [number, number]>("SELECT kind, COUNT(*) AS n FROM server_ingest_gaps WHERE at >= ? AND at < ? GROUP BY kind").all(since, until)
        .filter(row => kinds.includes(row.kind));
      if (rows.length) notes.push(`The hub knows it missed some of this: ${rows.map(row => `${row.n} gap${row.n === 1 ? "" : "s"} in ${row.kind}`).join(", ")}.`);
    }

    let lines: Line[];
    if (a.kind === "summary") {
      const counts = (Object.keys(kinds) as (keyof typeof kinds)[]).map(kind => {
        const found = kinds[kind]();
        return `${kind}: ${found.length}${found.length >= MAX_LINES ? "+" : ""}`;
      });
      notes.length = 0;
      lines = [{ at: since, text: `Counts in this window: ${counts.join("; ")}. Ask records with one kind to read them.` }];
    } else {
      lines = kinds[a.kind]().sort((x, y) => x.at - y.at);
    }
    const header = `Records ${a.kind}${who ? ` about ${who}` : ""}${area ? ` within ${area.radius} blocks of ${area.x},${area.z}` : ""}, ${stamp(since)} to ${stamp(until)}. [server] the game server recorded it; [hub] received by the hub when it happened, in a resident's words; [chat] public game chat.`;
    const truncated = lines.length > MAX_LINES;
    if (truncated) lines = lines.slice(-MAX_LINES);
    // Pages by characters; a continuation repeats the exact window so the pages stay one view.
    const pages: string[][] = [[]];
    let size = 0;
    for (const line of lines) {
      if (size + line.text.length + 1 > PAGE_CHARS && pages.at(-1)!.length) { pages.push([]); size = 0; }
      pages.at(-1)!.push(line.text); size += line.text.length + 1;
    }
    const page = a.page ?? 1;
    if (page > pages.length) return `${header}\nPage ${page} does not exist (${pages.length}).`;
    const body = pages[page - 1]!.length ? pages[page - 1]! : ["Nothing recorded in this window."];
    const more = page < pages.length
      ? [`Page ${page} of ${pages.length}. Continue: records kind=${a.kind}${who ? ` resident=${who}` : ""} since=${iso(since)} until=${iso(until)} page=${page + 1}`] : [];
    return [header, ...(page === 1 ? [...new Set(notes)] : []), ...(truncated && page === 1 ? [`Only the latest ${MAX_LINES} entries; narrow the window for earlier ones.`] : []), ...body, ...more].join("\n");
  };
}

export function recordsOperation(db: Database, resident: string, operation: string, args: unknown, deps: RecordsDeps = {}): string {
  if (operation !== "query") throw new Error("Unknown records operation.");
  return createRecords(db, resident, deps)(recordsArgs.parse(args));
}
