import { z } from "zod";
import type { Body } from "./body.ts";

/**
 * How a whole trip may change the world on its way.
 *
 * walk: Baritone may not break or place anything (allowBreak, allowPlace and allowWaterBucketFall false), so it
 * only walks, climbs, swims, falls safe heights and opens doors. A way that needs digging, pillaring or bridging
 * is not taken; the trip stops and says so.
 * excavate: Baritone may dig and build its way (allowBreak and allowPlace true, allowWaterBucketFall as the
 * settings file has it); built-looking blocks are avoided only by cost (blocksToAvoidBreaking).
 *
 * The mode is global and holds for the whole trip, from before the command until another trip, a stop, a death
 * or shutdown. Baritone 1.10.1 has no position-aware protection to use instead: CalculationContext
 * snapshots these settings for every path calculation, plans the next segment while walking the current one,
 * and its only per-position hook, CalculationContext.isPossiblyProtected, always returns false. Switching
 * settings when the body crosses a boundary would therefore not stop a path already planned with digging.
 */
export type TripMode = "walk" | "excavate";
export const tripSettingNames = ["allowBreak", "allowPlace", "allowWaterBucketFall"] as const;
export type TripSettingName = (typeof tripSettingNames)[number];
export type TripSettings = Record<TripSettingName, string>;
/** Baritone 1.10.1's defaults. Its settings file lists only settings that differ from them. */
export const baritoneTripDefaults: TripSettings = { allowBreak: "true", allowPlace: "true", allowWaterBucketFall: "true" };
/** What Baritone has, given its settings file as `name value` pairs: a setting the file leaves out is at its default. */
export function effectiveTripSettings(file: Record<string, string | undefined>): TripSettings {
  return Object.fromEntries(tripSettingNames.map(name => [name, file[name]?.trim().toLowerCase() || baritoneTripDefaults[name]])) as TripSettings;
}
const settingValue = z.enum(["true", "false"]);
/** The baseline file the body keeps while a trip has the settings changed. */
export const tripSettingsSchema: z.ZodType<TripSettings> = z.object({ allowBreak: settingValue, allowPlace: settingValue, allowWaterBucketFall: settingValue }).strict();
/** The settings a trip in `mode` runs with; `baseline` is what the settings file had before any trip changed it. */
export function tripSettings(mode: TripMode, baseline: TripSettings): TripSettings {
  return mode === "walk"
    ? { allowBreak: "false", allowPlace: "false", allowWaterBucketFall: "false" }
    : { allowBreak: "true", allowPlace: "true", allowWaterBucketFall: baseline.allowWaterBucketFall };
}
export const sameTripSettings = (a: TripSettings, b: TripSettings) => tripSettingNames.every(name => a[name] === b[name]);
/** Baritone 1.10.1's answer to the body's own `#set` of a trip setting (SetCommand), and to its own `#stop`
 * (ExecutionControlCommands): no news for the resident. "Old value: " is already read as the second `#set` line. */
export const tripSetReply = /^Successfully set (allowBreak|allowPlace|allowWaterBucketFall) to /;
export const stopReply = /^ok canceled$/;
/** For a reply: "walk-only" or "may dig and build". */
export const modeText = (mode: TripMode) => mode === "walk" ? "walk-only" : "may dig and build";

const finite = z.number().finite();
// Block coordinates use the containing block, including at negative positions.
const blockCoordinate = finite.transform(Math.floor);
const name = z.string().regex(/^\w{1,16}$/, "Use an in-game player name.");
const mode = z.enum(["walk", "excavate"]).optional();
const modeHelp = "mode walk (default) holds for the whole trip: nothing is broken or placed, so a way that needs digging, pillaring or bridging is not taken and the trip stops with a report instead of tunnelling through someone's wall. mode excavate lets Baritone dig and build its way (caves, mines, wild ground); it only avoids built-looking blocks by cost, so it can still break what someone built.";
export const navigationDefinitions = {
  go_to: {
    description: `Start Baritone travel; coordinates use the containing block (floats accepted). Leave y out unless you know the exact height of a block you can stand on: a guessed height is the commonest reason a trip stops short. ${modeHelp} Returns immediately; arrival is an event.`,
    schema: z.object({ x: blockCoordinate, z: blockCoordinate, y: blockCoordinate.optional(), mode }),
  },
  follow: { description: `Start following a named player. ${modeHelp}`, schema: z.object({ player: name, mode }) },
  explore: { description: `Start Baritone exploration. ${modeHelp}`, schema: z.object({ mode }) },
  stop: {
    description: "Stop Baritone and release held keys. It also ends a survival rescue in progress (coming up for air, climbing out of lava): only do that if you mean to take over, because the body stops saving you.",
    schema: z.object({}),
  },
};
export type NavigationTool = keyof typeof navigationDefinitions;
export type NavigationCommand = { [K in NavigationTool]: [K, z.infer<(typeof navigationDefinitions)[K]["schema"]>] }[NavigationTool];

/** Runs one navigation tool. The reply says what was sent and that Baritone's settings file read back as the mode. */
export async function executeNavigation(body: Body, command: NavigationCommand): Promise<string> {
  const [tool, args] = command;
  if (tool === "stop") return body.stopNavigation();
  const tripMode: TripMode = args.mode ?? "walk";
  let started: string;
  switch (tool) {
    case "go_to": {
      const goto = `#goto ${args.x} ${args.y === undefined ? "" : `${args.y} `}${args.z}`;
      await body.navigate(goto, { mode: tripMode, target: { x: args.x, z: args.z, ...(args.y === undefined ? {} : { y: args.y }) } });
      started = `Started ${goto}`;
      break;
    }
    case "follow":
      await body.navigate(`#follow player ${args.player}`, { mode: tripMode, follow: args.player });
      started = `Following ${args.player}`;
      break;
    case "explore":
      await body.navigate("#explore", { mode: tripMode });
      started = "Exploring";
      break;
  }
  return `${started} (${tripMode === "walk" ? "walk-only: Baritone's settings read back with breaking and placing off for this whole trip" : "excavate: Baritone may dig and build its way on this trip"}).`;
}

/** The status line for the trip under way. */
export function navigationStatus(body: Body): string {
  const nav = body.navigation;
  return `Navigation: ${nav ? `${nav.description} (${modeText(nav.mode)})${nav.reported ? " (arrival/stop reported)" : ""}` : "none"}`;
}
