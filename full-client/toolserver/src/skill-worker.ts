/**
 * Worker entry: the trusted host of one skill run. Skill code never executes in
 * this thread's JavaScript engine. It runs inside QuickJS compiled to
 * WebAssembly, a separate interpreter whose global object holds the language
 * built-ins and nothing else: no Bun, process, require, fetch, timers, modules,
 * files or network. Its only way out is the handful of functions injected
 * below, and those carry strings only, so no host object is ever reachable
 * from skill code. Policy (which tools, how many calls) is decided on the main
 * thread; time and memory limits are set here, outside the interpreter.
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSHandle } from "quickjs-emscripten-core";
import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import type { FromWorker, Outcome, ToWorker } from "./sandbox.ts";

declare var self: Worker;
const post = (message: FromWorker) => self.postMessage(message);
const cap = (text: string, length: number) => text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** Names that must not exist inside the interpreter; checked before any skill code runs. */
const forbidden = ["process", "Bun", "require", "module", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "postMessage", "setTimeout", "setInterval", "std", "os", "Deno", "navigator", "console"];
/** Lines stay exact: the skill's first line shares line 1 with this header. */
const wrap = (code: string) => `(async function (body, state, args, log, sleep) { "use strict"; ${code}\n})`;
/** Builds the skill's API inside the interpreter from string-only host functions, then starts the skill. */
const bridge = `(function (call, readState, logLine, sleepMs, done, argsJson, skill) {
  "use strict";
  const text = value => { try { return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? String(value); } catch { return String(value); } };
  const failure = error => {
    try {
      const plain = error !== null && typeof error === "object";
      return JSON.stringify({ name: String(plain && error.name || "Error"), message: String(plain && "message" in error ? error.message : error), stack: String(plain && error.stack || ""), tool: plain && typeof error.tool === "string" ? error.tool : undefined });
    } catch { return JSON.stringify({ name: "Error", message: "the skill threw a value that could not be described", stack: "" }); }
  };
  const body = new Proxy(Object.create(null), { get: (_, tool) => typeof tool !== "string" ? undefined : input =>
    call(tool, input === undefined ? "{}" : JSON.stringify(input) ?? "null").then(null, message => {
      const error = new Error(message); error.name = "ToolError"; error.tool = tool; throw error;
    }) });
  const state = () => readState().then(JSON.parse);
  const log = (...parts) => { logLine(parts.map(text).join(" ")); };
  const sleep = ms => sleepMs(Number(ms) || 0);
  Promise.resolve().then(() => skill(body, state, JSON.parse(argsJson), log, sleep)).then(value => done("1", text(value)), error => done("", failure(error)));
})`;

function lineOf(error: { lineNumber?: unknown; stack?: unknown }) {
  const fromStack = /skill:(\d+)/.exec(String(error.stack ?? ""))?.[1];
  const line = fromStack ? Number(fromStack) : typeof error.lineNumber === "number" ? error.lineNumber : undefined;
  return line !== undefined && line >= 1 ? line : undefined;
}
function described(value: unknown): { name: string; message: string; line?: number; tool?: string } {
  const error = (value !== null && typeof value === "object" ? value : { message: String(value) }) as Record<string, unknown>;
  return {
    name: cap(String(error.name ?? "Error"), 60), message: cap(String(error.message ?? ""), 400), line: lineOf(error),
    ...(typeof error.tool === "string" ? { tool: cap(error.tool, 60) } : {}),
  };
}

async function start(message: Extract<ToWorker, { type: "start" }>) {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(message.memoryBytes);
  // Below the worker thread's own stack (which gave out near 500 KiB here), so runaway
  // recursion is normally the interpreter's error to report; either way the run just fails.
  runtime.setMaxStackSize(400 * 1024);
  const flag = new Int32Array(message.flag);
  let interrupted: "time" | "cancelled" | undefined;
  // Called by the interpreter while skill code runs; a true result ends that code and cannot be caught by it.
  runtime.setInterruptHandler(() => {
    if (Atomics.load(flag, 0) !== 0) interrupted = "cancelled";
    else if (Date.now() >= message.deadline) interrupted = "time";
    return interrupted !== undefined;
  });
  const vm = runtime.newContext();
  const probe = vm.evalCode(`${JSON.stringify(forbidden)}.filter(name => typeof globalThis[name] !== "undefined").join(" ")`, "probe");
  if (probe.error) throw new Error("the isolation self-test could not run");
  const exposed = vm.getString(probe.value);
  probe.value.dispose();
  if (exposed) throw new Error(`the isolation self-test found ${exposed} inside the interpreter`);
  post({ type: "ready" });

  let finished = false;
  const logs: string[] = [];
  let logCount = 0;
  const finish = (outcome: Outcome) => {
    if (finished) return;
    finished = true;
    post({ type: "done", outcome, logs, logCount });
  };
  if (message.check) {
    const compiled = vm.evalCode(wrap(message.code), "skill", { compileOnly: true });
    if (compiled.error) {
      const error = described(vm.dump(compiled.error));
      finish({ kind: "syntax", message: error.message, line: error.line });
    } else finish({ kind: "finished", value: "" });
    return;
  }
  const compiled = vm.evalCode(wrap(message.code), "skill");
  if (compiled.error) {
    const error = described(vm.dump(compiled.error));
    finish(interrupted ? { kind: interrupted } : { kind: "syntax", message: error.message, line: error.line });
    return;
  }

  /** Bridge requests and sleeps the skill is waiting on; with none left and no result it can never finish. */
  let waiting = 0, requests = 0, nextId = 0;
  const replies = new Map<number, (reply: Extract<ToWorker, { type: "reply" }>) => void>();
  const pump = () => {
    if (finished) return;
    try {
      const jobs = runtime.executePendingJobs();
      if (interrupted) { finish({ kind: interrupted }); return; }
      if (jobs.error) { finish({ kind: "error", ...described(vm.dump(jobs.error)) }); return; }
    } catch (error) {
      finish({ kind: "error", name: "InternalError", message: `the interpreter stopped: ${cap(error instanceof Error ? error.message : String(error), 200)}` });
      return;
    }
    if (!finished && waiting === 0) finish({ kind: "stalled" });
  };
  const request = (kind: "call" | "state", tool = "", args = "") => {
    // The main thread enforces the real limits; this only stops a loop that never awaits from flooding it.
    if (++requests > message.maxRequests) throw new Error("too many requests to the body in one run");
    const deferred = vm.newPromise();
    const id = ++nextId;
    waiting++;
    replies.set(id, reply => {
      replies.delete(id); waiting--;
      const value = vm.newString(reply.text);
      if (reply.ok) deferred.resolve(value); else deferred.reject(value);
      value.dispose();
      pump();
    });
    post(kind === "call" ? { type: "call", id, tool, args } : { type: "state", id });
    return deferred.handle;
  };
  self.onmessage = event => {
    const reply = event.data as ToWorker;
    if (reply.type === "reply") replies.get(reply.id)?.(reply);
  };
  const host: QuickJSHandle[] = [
    vm.newFunction("call", (tool, args) => request("call", cap(vm.getString(tool), 60), vm.getString(args))),
    vm.newFunction("readState", () => request("state")),
    vm.newFunction("logLine", line => {
      const text = cap(vm.getString(line).replace(/\s+/g, " ").trim(), 200);
      logs.push(text); if (logs.length > 20) logs.shift();
      // Lines of a run that is later killed are only known from these messages.
      if (++logCount <= 200) post({ type: "log", text });
    }),
    vm.newFunction("sleepMs", ms => {
      const deferred = vm.newPromise();
      waiting++;
      setTimeout(() => { waiting--; deferred.resolve(vm.undefined); pump(); }, Math.min(Math.max(vm.getNumber(ms) || 0, 0), 600_000));
      return deferred.handle;
    }),
    vm.newFunction("done", (ok, payload) => {
      const text = vm.getString(payload);
      if (vm.getString(ok)) finish({ kind: "finished", value: cap(text, 2000) });
      else {
        let error: unknown = {};
        try { error = JSON.parse(text); } catch {}
        finish({ kind: "error", ...described(error) });
      }
    }),
    vm.newString(message.argsJson),
    compiled.value,
  ];
  const boot = vm.unwrapResult(vm.evalCode(bridge, "bridge"));
  const started = vm.callFunction(boot, vm.undefined, ...host);
  if (started.error) { finish({ kind: "error", ...described(vm.dump(started.error)) }); return; }
  pump();
}

self.onmessage = event => {
  const message = event.data as ToWorker;
  if (message.type !== "start") return;
  start(message).catch(error => post({ type: "done", outcome: { kind: "unavailable", message: cap(error instanceof Error ? error.message : String(error), 200) }, logs: [], logCount: 0 }));
};
