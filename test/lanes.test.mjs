#!/usr/bin/env node
// Unit coverage for the opt-in lane layer (#76). End-to-end behaviour through a real client
// lives in test/session-cardinality.test.mjs.
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { lanesEnabled, laneSessionKey, isLaneSessionKey, createLaneQueue, applyLanes, LANE_ID_PATTERN } from "../lanes.js";
import { currentSessionId } from "../session-context.js";

test("lanes are off unless SAFARI_MCP_LANES is set to something other than 0", () => {
  assert.equal(lanesEnabled({}), false);
  assert.equal(lanesEnabled({ SAFARI_MCP_LANES: "0" }), false);
  assert.equal(lanesEnabled({ SAFARI_MCP_LANES: "" }), false);
  assert.equal(lanesEnabled({ SAFARI_MCP_LANES: "1" }), true);
});

test("lane keys are namespaced so they can never collide with a transport session id", () => {
  assert.equal(laneSessionKey("pi-a"), "lane:pi-a");
  assert.ok(isLaneSessionKey("lane:pi-a"));
  assert.ok(!isLaneSessionKey("_default"));
  assert.ok(!isLaneSessionKey("3f1c0a4e-uuid"));
  assert.ok(LANE_ID_PATTERN.test("pi.session-01:002"));
  for (const bad of ["", "a b", "x".repeat(129), "tab'42", 'a"b', "a\nb"]) {
    assert.ok(!LANE_ID_PATTERN.test(bad), `must refuse ${JSON.stringify(bad)}`);
  }
});

test("a failing call does not wedge its lane, and idle lanes are released", async () => {
  const q = createLaneQueue();
  const order = [];
  const failing = q.run("k", async () => { order.push("fail"); throw new Error("boom"); });
  const next = q.run("k", async () => { order.push("next"); return 42; });
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 42);
  assert.deepEqual(order, ["fail", "next"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(q.size, 0, "an idle lane must not stay in the map");
});

test("applyLanes adds a required laneId and runs the handler under the lane key", async () => {
  const registered = [];
  const fake = { tool: (...args) => registered.push(args) };
  applyLanes(fake);
  fake.tool("t4", "desc", { a: {} }, async (args) => ({ args, sid: currentSessionId() }));
  fake.tool("t3", "desc", async () => currentSessionId());
  fake.tool("t2", async () => currentSessionId());

  const [name, desc, shape, cb] = registered[0];
  assert.equal(name, "t4");
  assert.equal(desc, "desc");
  assert.deepEqual(Object.keys(shape).sort(), ["a", "laneId"]);
  const out = await cb({ a: 1, laneId: "pi-a" }, {});
  assert.deepEqual(out.args, { a: 1 }, "laneId must be stripped before the handler sees its args");
  assert.equal(out.sid, "lane:pi-a");

  assert.ok("laneId" in registered[1][2], "(name, desc, cb) form must get a shape");
  assert.ok("laneId" in registered[2][1], "(name, cb) form must get a shape");
  await assert.rejects(registered[1][3]({}, {}), /laneId/);
});

test("index.js only applies lanes behind the flag, with one queue shared by every session", () => {
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(src, /const _LANES = lanesEnabled\(process\.env\);/);
  assert.match(src, /const _laneQueue = _LANES \? createLaneQueue\(\) : null;/);
  const build = src.slice(src.indexOf("function buildServer()"), src.indexOf("// ========== NAVIGATION =========="));
  assert.match(build, /if \(_LANES\) applyLanes\(server, \{ queue: _laneQueue \}\);/);
});
