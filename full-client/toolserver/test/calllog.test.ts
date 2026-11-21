import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCallLog } from "../src/calllog.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("each call becomes one JSON line with its tool, arguments, reply and error flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "calllog-")); dirs.push(dir);
  const path = join(dir, "calls.jsonl");
  const call = withCallLog(path, async name => name === "look"
    ? { content: [{ type: "text", text: "Looked.\nSince last time:\n1 chat from=Margo text=hi" }] }
    : { content: [{ type: "text", text: "Error: no such thing" }], isError: true });
  await call("look", { x: 1, y: 2, z: 3 });
  await call("craft", { item: "chest" });
  const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(lines.map(line => [line.tool, line.args, line.error])).toEqual([["look", { x: 1, y: 2, z: 3 }, false], ["craft", { item: "chest" }, true]]);
  expect(lines[0].text).toContain("1 chat from=Margo text=hi");
});

test("a log that cannot be written never fails the call", async () => {
  const call = withCallLog("/nonexistent-dir/calls.jsonl", async () => ({ content: [{ type: "text", text: "ok" }] }));
  expect((await call("status", {})).content).toEqual([{ type: "text", text: "ok" }]);
});
