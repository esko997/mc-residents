// Run controls on the Residents panel: state of each resident's run, and Start/Stop.
//
// Status comes from api/runs (the dashboard URL is enough to read it). Starting and
// stopping go to /controller/v1/ with a controller bearer token that the person enters
// once; the dashboard URL alone cannot spend model quota (docs/run-controller.md).
// The helpers at the top are pure (no DOM) and tested in test/run-control.test.js.

export const ZONE = "America/New_York";
const TOKEN_KEY = "commons.runControlToken";

// ---------- pure helpers ----------

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms, zone = ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** The first instant whose wall clock in `zone` reads these parts; null when that time does not exist there (spring forward). */
export function wallToEpoch({ year, month, day, hour, minute }, zone = ZONE) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const found = [];
  // The zone's offset near that wall time, tried on both sides of a transition.
  for (const probe of [wall - 86_400_000, wall, wall + 86_400_000]) {
    const p = zonedParts(probe, zone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - probe;
    const candidate = wall - offset;
    const back = zonedParts(candidate, zone);
    if (back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute) found.push(candidate);
  }
  return found.length ? Math.min(...found) : null;
}

/** The next time strictly after `nowMs` that the clock in `zone` reads hour:minute (default: the next 1:00 am in New York). */
export function nextWallTime(nowMs, hour = 1, minute = 0, zone = ZONE) {
  const today = zonedParts(nowMs, zone);
  for (let days = 0; days < 4; days++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
    const at = wallToEpoch({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }, zone);
    if (at !== null && at > nowMs) return at;
  }
  return null;
}

/** "01:00" today/tonight, else "Tue 01:00", in New York time. */
export function endLabel(endAtSeconds, nowMs, zone = ZONE) {
  const ms = endAtSeconds * 1000;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  if (ms - nowMs < 20 * 3600_000 && ms > nowMs) return time;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(ms)} ${time}`;
}

/** Value strings for <input type=date> and <input type=time> showing an instant in New York. */
export function wallInputs(ms, zone = ZONE) {
  const p = zonedParts(ms, zone), two = n => String(n).padStart(2, "0");
  return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
}

/** Parse those inputs back to Unix seconds; an error sentence instead when impossible. */
export function inputsToEndAt(date, time, nowMs, zone = ZONE) {
  const d = /^(\d{4})-(\d\d)-(\d\d)$/.exec(date ?? ""), t = /^(\d\d):(\d\d)$/.exec(time ?? "");
  if (!d || !t) return { error: "Choose an end date and time." };
  const ms = wallToEpoch({ year: +d[1], month: +d[2], day: +d[3], hour: +t[1], minute: +t[2] }, zone);
  if (ms === null) return { error: `${time} does not exist on ${date} in New York (clocks go forward).` };
  if (ms <= nowMs) return { error: "That end time is in the past." };
  if (ms - nowMs > 24 * 3600_000) return { error: "That end time is more than 24 hours away." };
  return { endAt: Math.floor(ms / 1000) };
}

const RESULT_WORDS = {
  started: "started", already_running: "already running", stopped: "stopped", not_running: "was not running",
  failed: "failed", still_active: "still active", restarted: "restarted", left_running: "left running", off: "off", not_needed: "not needed",
};

/** One line per resident run for a card, from api/runs. */
export function runSummary(run, nowMs) {
  if (!run) return "Run state unknown.";
  if (run.running) {
    const parts = [`Running until ${run.end_at ? endLabel(run.end_at, nowMs) : "an unknown time"}`];
    if (run.model) parts.push(run.model);
    if (run.mode) parts.push(run.mode === "resume" ? `resumed thread${run.thread_id ? ` ${run.thread_id.slice(0, 8)}…` : ""}` : "fresh thread");
    if (run.dry_run) parts.push("dry run (no mind)");
    if (run.started_by) parts.push(`started by ${run.started_by}`);
    return `${parts.join(" · ")}.`;
  }
  const client = run.client_state && run.client_state !== "inactive" ? ` Client ${run.client_state} without a run.` : "";
  return `Not running.${run.started_by ? ` Last started by ${run.started_by}${run.end_at ? ` until ${endLabel(run.end_at, nowMs)}` : ""}.` : ""}${client}`;
}

/** The confirmation text for a stop: exactly what will stop, by host. */
export function stopConfirmation(targets, hosts) {
  const lines = [];
  for (const host of hosts) {
    const mine = targets.filter(t => t.host === host.host);
    if (!mine.length) continue;
    const names = new Set(mine.map(t => t.name.toLowerCase()));
    const units = host.residents.filter(r => names.has(r.name.toLowerCase()))
      .map(r => `${r.name} (${[r.running ? r.unit : null, r.client_state && r.client_state !== "inactive" ? r.client_unit : null].filter(Boolean).join(" and ") || "nothing running"})`);
    const others = host.residents.filter(r => r.running && !names.has(r.name.toLowerCase()));
    const caretaker = host.caretaker?.running
      ? others.length ? ` The caretaker keeps running for ${others.map(r => r.name).join(", ")}.` : ` The caretaker ${host.caretaker.unit ?? ""} stops too.`.replace("  ", " ")
      : "";
    lines.push(`On ${host.host}: ${units.join(", ")}.${caretaker}`);
  }
  const unknown = targets.filter(t => !hosts.some(h => h.host === t.host));
  for (const t of unknown) lines.push(`On ${t.host}: ${t.name} (its run state is unknown).`);
  return `Stop ${targets.length === 1 ? targets[0].name : "these residents"}?\n\n${lines.join("\n")}\n\nEach run saves and commits its notes as it stops.`;
}

/** Per-host result lines of a start/stop reply; a failure is never folded into another host's success. */
export function resultLines(reply) {
  if (!reply || !Array.isArray(reply.hosts) || reply.hosts.length === 0) return [{ ok: false, text: reply?.error ?? "No answer from Commons." }];
  const lines = reply.hosts.map(host => {
    if (!host.ok && !host.residents.length) {
      const error = host.error ?? host.code;
      return { ok: false, host: host.host, text: error.startsWith(host.host) || error.startsWith("station ") ? error : `${host.host}: ${error}` };
    }
    const residents = host.residents.map(r => `${r.name} ${RESULT_WORDS[r.result] ?? r.result ?? "?"}${r.result === "started" && r.mode ? ` (${r.mode === "resume" ? "resumed thread" : "fresh thread"})` : ""}${r.error ? `: ${r.error}` : ""}`);
    const caretaker = host.caretaker?.result && host.caretaker.result !== "off" ? [`caretaker ${RESULT_WORDS[host.caretaker.result] ?? host.caretaker.result}`] : [];
    const tail = !host.ok && host.error ? ` — ${host.error}` : "";
    return { ok: host.ok, host: host.host, text: `${host.host}: ${[...residents, ...caretaker].join(", ") || "nothing to do"}${tail}` };
  });
  return [...lines, ...(reply.warnings ?? []).map(text => ({ ok: false, text }))];
}

/** The JSON body for POST start, from the dialog's fields; unset choices fall to each host's run.conf. */
export function startBody({ residents, endAt, model, fresh, caretaker, interval, speak }) {
  const body = { residents, end_at: endAt };
  if (model) body.model = model;
  if (fresh) body.fresh = residents;
  const care = {};
  if (caretaker === "on" || caretaker === "off") care.enabled = caretaker === "on";
  if (interval) care.interval = Number(interval);
  if (speak && speak !== "keep") care.speak = speak;
  if (Object.keys(care).length) body.caretaker = care;
  return body;
}

// ---------- page ----------

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function storedToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

/**
 * The bar above the cards, a slot in each card and one dialog. `serverNow` is the
 * page's server-adjusted clock.
 */
export function createRunControls({ bar, tokenForm, dialog, serverNow }) {
  const state = { hosts: [], at: 0, loading: false, busy: false, messages: [], error: "" };
  const form = dialog.querySelector("form");
  const field = name => form.elements.namedItem(name);
  let pending = null; // { residents, label }

  async function refresh(force = false) {
    if (state.loading || (!force && Date.now() - state.at < 10_000)) return;
    state.loading = true;
    try {
      const response = await fetch("api/runs", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.hosts)) throw new Error(data.error ?? `Commons answered ${response.status}.`);
      state.hosts = data.hosts; state.error = ""; state.at = Date.now();
    } catch (error) { state.error = `Run state unavailable: ${error.message}`; }
    finally { state.loading = false; }
    drawBar();
    document.dispatchEvent(new CustomEvent("runs-changed"));
  }

  const runOf = (name, host) => state.hosts.find(h => h.host === host)?.residents.find(r => r.name.toLowerCase() === name.toLowerCase());

  async function send(action, body) {
    const token = storedToken();
    if (!token) return [{ ok: false, text: "Enter the controller token above first; the dashboard address alone cannot start or stop runs." }];
    state.busy = true; drawBar();
    try {
      const response = await fetch(`/controller/v1/${action}`, {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({ error: `Commons answered ${response.status}.` }));
      if (response.status === 401) {
        forget();
        return [{ ok: false, text: `${data.error ?? "The controller token was refused."} The saved token was forgotten.` }];
      }
      return resultLines(data);
    } catch (error) {
      return [{ ok: false, text: `Commons could not be reached: ${error.message}. The result is unknown; check the run state.` }];
    } finally {
      state.busy = false;
      void refresh(true);
    }
  }

  function forget() {
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
    drawBar();
    document.dispatchEvent(new CustomEvent("runs-changed"));
  }

  function openStart(residents, label) {
    pending = { residents, label };
    const end = nextWallTime(serverNow(), 1, 0);
    const inputs = wallInputs(end);
    field("date").value = inputs.date; field("time").value = inputs.time;
    field("model").value = ""; field("thread").value = "resume";
    field("caretaker").value = "default"; field("interval").value = ""; field("speak").value = "keep";
    dialog.querySelector(".who").textContent = label;
    dialog.querySelector(".problem").textContent = "";
    updateWhen();
    dialog.showModal();
  }

  function updateWhen() {
    const parsed = inputsToEndAt(field("date").value, field("time").value, serverNow());
    const note = dialog.querySelector(".when");
    if (parsed.error) { note.textContent = parsed.error; return; }
    const minutes = Math.round((parsed.endAt * 1000 - serverNow()) / 60_000);
    note.textContent = `Ends ${endLabel(parsed.endAt, serverNow())} New York time, in ${Math.floor(minutes / 60)} h ${minutes % 60} min. Every running resident shares this end time.`;
  }

  async function submitStart(event) {
    event.preventDefault();
    if (event.submitter?.value === "cancel") { dialog.close(); return; }
    const parsed = inputsToEndAt(field("date").value, field("time").value, serverNow());
    if (parsed.error) { dialog.querySelector(".problem").textContent = parsed.error; return; }
    const body = startBody({
      residents: pending.residents, endAt: parsed.endAt, model: field("model").value.trim(), fresh: field("thread").value === "fresh",
      caretaker: field("caretaker").value, interval: field("interval").value, speak: field("speak").value,
    });
    dialog.querySelector(".problem").textContent = "Starting…";
    state.messages = await send("start", body);
    dialog.close();
    drawBar();
  }

  async function stop(targets) {
    if (!targets.length) return;
    if (!confirm(stopConfirmation(targets, state.hosts))) return;
    const residents = targets.length === state.hosts.flatMap(h => h.residents).length && targets.every(t => t.all) ? "all" : targets.map(t => t.name);
    state.messages = [{ ok: true, text: "Stopping… (each run commits its notes; this can take a minute)" }];
    drawBar();
    state.messages = await send("stop", { residents });
    drawBar();
  }

  function drawBar() {
    const now = serverNow();
    const summary = state.hosts.map(host => {
      if (!host.ok && !host.residents.length) return element("span", { className: "error", textContent: host.error ?? `${host.host}: ${host.code}` });
      const running = host.residents.filter(r => r.running);
      const ends = [...new Set(running.map(r => r.end_at))];
      const words = running.length
        ? `${running.map(r => r.name).join(", ")} running until ${ends.map(e => e ? endLabel(e, now) : "?").join(" / ")}`
        : "no resident running";
      const caretaker = host.caretaker?.running ? "; caretaker on" : "";
      return element("span", { textContent: `${host.host}: ${words}${caretaker}.`, className: ends.length > 1 ? "warn" : "" });
    });
    const token = storedToken();
    const everyone = state.hosts.flatMap(h => h.residents.map(r => ({ name: r.name, host: h.host, all: true })));
    const startAll = element("button", { type: "button", textContent: "Start all…", disabled: state.busy });
    startAll.onclick = () => openStart("all", "All residents on every host");
    const stopAll = element("button", { type: "button", textContent: "Stop all…", disabled: state.busy || !state.hosts.some(h => h.residents.some(r => r.running) || h.caretaker?.running) });
    stopAll.onclick = () => stop(everyone);
    // Asked for once (static form, so a refresh never wipes what is typed); the dashboard address alone never starts or stops anything.
    tokenForm.hidden = Boolean(token);
    const lock = token ? element("button", { type: "button", className: "quiet", textContent: "Forget controller token" }) : null;
    if (lock) lock.onclick = forget;
    startAll.disabled ||= !token;
    stopAll.disabled ||= !token;
    bar.replaceChildren(...[
      element("div", { className: "runs-line" }, element("b", { textContent: "Runs" }), ...summary, state.error ? element("span", { className: "error", textContent: state.error }) : null),
      element("div", { className: "runs-buttons" }, startAll, stopAll, lock),
      state.messages.length ? element("ul", { className: "runs-messages", role: "status" },
        ...state.messages.map(m => element("li", { className: m.ok ? "ok" : "error", textContent: m.text }))) : null,
    ].filter(Boolean));
  }

  /** The run line and buttons in one resident's card. */
  function renderCard(slot, resident) {
    const run = runOf(resident.name, resident.host);
    const running = Boolean(run?.running), bodyUp = run?.client_state && run.client_state !== "inactive";
    const locked = !storedToken();
    const start = element("button", { type: "button", textContent: "Start…", disabled: locked || state.busy || running || resident.hostUnreachable || !run });
    start.onclick = () => openStart([resident.name], `${resident.name} on ${resident.host}`);
    const end = element("button", { type: "button", textContent: "Stop…", disabled: locked || state.busy || (!running && !bodyUp) });
    end.onclick = () => stop([{ name: resident.name, host: resident.host }]);
    const text = resident.hostUnreachable ? `Host ${resident.host} unreachable: run state unknown.` : runSummary(run, serverNow());
    slot.replaceChildren(element("p", { className: running ? "run-line running" : "run-line" }, text), element("span", { className: "run-buttons" }, start, end));
  }

  tokenForm.addEventListener("submit", event => {
    event.preventDefault();
    const input = tokenForm.elements.namedItem("token"), remember = tokenForm.elements.namedItem("remember");
    const value = input.value.trim();
    input.setCustomValidity(/^[A-Za-z0-9_-]{16,512}$/.test(value) ? "" : "That is not a controller token.");
    if (!input.reportValidity()) return;
    try { (remember.checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, value); } catch { /* storage blocked */ }
    input.value = "";
    drawBar();
    document.dispatchEvent(new CustomEvent("runs-changed"));
  });
  form.addEventListener("submit", submitStart);
  form.addEventListener("input", event => { if (["date", "time"].includes(event.target.name)) updateWhen(); });
  drawBar();
  return { refresh, renderCard };
}
