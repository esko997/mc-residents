// States of the systemd user units that run the residents. The app also runs
// where there is no systemd (a laptop, a test): then every unit reads "unknown".

const cache = new Map<string, { at: number; states: Record<string, string> }>();

/** `systemctl --user is-active a b c` prints one state per line, in order. */
export async function unitStates(systemctl: string, units: string[], maxAgeMs = 5000): Promise<Record<string, string>> {
  const key = `${systemctl} ${units.join(" ")}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.states;
  const states: Record<string, string> = Object.fromEntries(units.map(unit => [unit, "unknown"]));
  if (units.length) {
    try {
      const child = Bun.spawn([systemctl, "--user", "is-active", ...units], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => child.kill(), 3000);
      // is-active exits non-zero whenever any unit is not active; only the lines matter.
      const lines = (await new Response(child.stdout).text()).trim().split("\n").map(line => line.trim());
      clearTimeout(timer);
      await child.exited;
      if (lines.length === units.length) units.forEach((unit, index) => { states[unit] = lines[index] || "unknown"; });
    } catch { /* no systemctl here */ }
  }
  cache.set(key, { at: Date.now(), states });
  return states;
}
