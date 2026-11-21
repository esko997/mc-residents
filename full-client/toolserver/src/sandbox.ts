/**
 * Runs skill code in an isolated interpreter (see skill-worker.ts) and answers
 * its bridge requests. The worker thread keeps a runaway skill off this
 * thread, so the body's poller and rescues keep working while a skill spins;
 * the interpreter inside it is what keeps skill code away from files, the
 * network and this process. If either cannot be set up the outcome is
 * `unavailable`: skill code is never run any other way.
 */
export type Outcome =
  | { kind: "finished"; value: string }
  | { kind: "syntax"; message: string; line?: number }
  /** The code threw and did not catch it; `tool` names the body tool whose error it was. */
  | { kind: "error"; name: string; message: string; line?: number; tool?: string }
  | { kind: "time" }
  | { kind: "cancelled" }
  /** The code awaits something nothing will ever resolve. */
  | { kind: "stalled" }
  | { kind: "unavailable"; message: string };
export type ToWorker =
  | { type: "start"; code: string; argsJson: string; check: boolean; deadline: number; memoryBytes: number; maxRequests: number; flag: SharedArrayBuffer }
  | { type: "reply"; id: number; ok: boolean; text: string };
export type FromWorker =
  | { type: "ready" }
  | { type: "call"; id: number; tool: string; args: string }
  | { type: "state"; id: number }
  | { type: "log"; text: string }
  | { type: "done"; outcome: Outcome; logs: string[]; logCount: number };

export interface Bridge {
  /** A body tool call from skill code; a rejection is thrown inside the skill, where it may be caught. */
  call(tool: string, args: unknown): Promise<string>;
  /** JSON text of the structured state. */
  state(): Promise<string>;
}
export interface SandboxRun {
  code: string;
  /** Only compile, to report syntax errors; nothing runs and no bridge is needed. */
  check?: boolean;
  argsJson?: string;
  bridge?: Bridge;
  /** Wall-clock end, as Date.now() milliseconds. */
  deadline: number;
  signal?: AbortSignal;
  /** The worker's entry file; `interpreter` unless a test points it elsewhere. */
  entry?: string;
}
export interface SandboxResult { outcome: Outcome; logs: string[]; logCount: number }

export const memoryBytes = 64 * 1024 * 1024;
export const interpreter = new URL("./skill-worker.ts", import.meta.url).href;
const startupMs = 10_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function runInSandbox(run: SandboxRun): Promise<SandboxResult> {
  const { promise, resolve } = Promise.withResolvers<SandboxResult>();
  const flag = new SharedArrayBuffer(4);
  let logs: string[] = [], logCount = 0;
  let worker: Worker;
  try { worker = new Worker(run.entry ?? interpreter); }
  catch (error) { return Promise.resolve({ outcome: { kind: "unavailable", message: message(error) }, logs, logCount }); }
  let settled = false, ready = false;
  const finish = (outcome: Outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(startup); clearTimeout(limit);
    run.signal?.removeEventListener("abort", abort);
    // The flag ends code that is running inside the interpreter; terminate ends the thread whatever it is doing.
    Atomics.store(new Int32Array(flag), 0, 1);
    worker.terminate();
    resolve({ outcome, logs, logCount });
  };
  const abort = () => finish({ kind: "cancelled" });
  const startup = setTimeout(() => finish({ kind: "unavailable", message: "the interpreter did not start in 10 s" }), startupMs);
  // The interpreter's own deadline only fires while skill code is executing; this one also covers a skill that is waiting.
  const limit = setTimeout(() => finish({ kind: "time" }), Math.max(0, run.deadline - Date.now()));
  let queue = Promise.resolve();
  const answer = (id: number, work: () => Promise<string>) => {
    // One request at a time, in the order the skill made them, even when it does not await each one.
    queue = queue.then(async () => {
      if (settled) return;
      let reply: ToWorker;
      try { reply = { type: "reply", id, ok: true, text: await work() }; }
      catch (error) { reply = { type: "reply", id, ok: false, text: message(error) }; }
      if (!settled) worker.postMessage(reply);
    });
  };
  worker.onmessage = event => {
    const received = event.data as FromWorker;
    if (settled) return;
    switch (received.type) {
      case "ready": ready = true; clearTimeout(startup); break;
      case "log": logs.push(received.text); if (logs.length > 20) logs.shift(); logCount++; break;
      case "call": answer(received.id, async () => {
        let args: unknown;
        try { args = JSON.parse(received.args); } catch { throw new Error("Tool arguments must be a JSON object."); }
        return run.bridge!.call(received.tool, args);
      }); break;
      case "state": answer(received.id, () => run.bridge!.state()); break;
      case "done":
        if (received.outcome.kind === "finished" || received.logCount >= logCount) { logs = received.logs; logCount = received.logCount; }
        finish(received.outcome);
    }
  };
  worker.onerror = event => finish(ready
    ? { kind: "error", name: "InternalError", message: `the interpreter stopped: ${event.message}` }
    : { kind: "unavailable", message: event.message || "the interpreter could not be loaded" });
  if (run.signal?.aborted) abort();
  else {
    run.signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({
      type: "start", code: run.code, argsJson: run.argsJson ?? "{}", check: run.check === true,
      deadline: run.deadline, memoryBytes, maxRequests: 5000, flag,
    } satisfies ToWorker);
  }
  return promise;
}
