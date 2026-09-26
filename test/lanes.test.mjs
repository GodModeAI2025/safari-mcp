#!/usr/bin/env node
// Unit coverage for the opt-in lane layer (#76). End-to-end behaviour through a real client
// lives in test/session-cardinality.test.mjs.
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { lanesEnabled, laneSessionKey, isLaneSessionKey, createLaneQueue, applyLanes, LANE_ID_PATTERN, laneIdleMs, DEFAULT_LANE_IDLE_MS } from "../lanes.js";
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
  assert.match(src, /const _laneQueue = _LANES\s*\? createLaneQueue\(\{/);
  assert.match(src, /idleMs: laneIdleMs\(process\.env\)/);
  assert.match(src, /safari\._dropSession\(key\);/, "a released lane must drop its tab state");
  assert.match(src, /_activeReceipts\.delete\(`\$\{SESSION_ID\}:\$\{key\}`\);/, "and its active receipt");
  assert.match(src, /_laneQueue\?\.startSweeper\(\);/);
  const build = src.slice(src.indexOf("function buildServer()"), src.indexOf("// ========== NAVIGATION =========="));
  assert.match(build, /if \(_LANES\) applyLanes\(server, \{ queue: _laneQueue \}\);/);
});

test("idle window: default 1h, 0 disables release, garbage falls back to the default", () => {
  assert.equal(laneIdleMs({}), DEFAULT_LANE_IDLE_MS);
  assert.equal(DEFAULT_LANE_IDLE_MS, 3600000);
  assert.equal(laneIdleMs({ SAFARI_MCP_LANE_IDLE_MS: "0" }), 0);
  assert.equal(laneIdleMs({ SAFARI_MCP_LANE_IDLE_MS: "120000" }), 120000);
  assert.equal(laneIdleMs({ SAFARI_MCP_LANE_IDLE_MS: "soon" }), DEFAULT_LANE_IDLE_MS);
  assert.equal(laneIdleMs({ SAFARI_MCP_LANE_IDLE_MS: "-5" }), DEFAULT_LANE_IDLE_MS);
});

test("sweep releases only lanes idle past the window, never one with work in flight", async () => {
  let t = 0;
  const released = [];
  const q = createLaneQueue({ idleMs: 1000, now: () => t, onRelease: (k) => released.push(k) });
  await q.run("lane:old", async () => {});
  t = 500;
  await q.run("lane:recent", async () => {});
  let finish;
  const busy = q.run("lane:busy", () => new Promise((r) => { finish = r; }));
  await new Promise((r) => setImmediate(r)); // let the queued call start
  t = 1400;
  assert.deepEqual(q.sweep(), ["lane:old"], "only the lane silent for >= idleMs goes");
  t = 10_000;
  assert.deepEqual(q.sweep(), ["lane:recent"], "a running lane is never released, however old");
  finish();
  await busy;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(q.sweep(), [], "its idle clock restarts when the call finishes");
  t = 11_000;
  assert.deepEqual(q.sweep(), ["lane:busy"]);
  assert.deepEqual(released, ["lane:old", "lane:recent", "lane:busy"]);
  assert.equal(q.lanes, 0);
});

test("idleMs 0 never releases and starts no timer", async () => {
  let t = 0;
  const q = createLaneQueue({ idleMs: 0, now: () => t, onRelease: () => assert.fail("released") });
  await q.run("lane:a", async () => {});
  t = 1e12;
  assert.deepEqual(q.sweep(), []);
  const stop = q.startSweeper();
  stop();
});

test("a throwing release hook does not stop the sweep", async () => {
  let t = 0;
  const q = createLaneQueue({ idleMs: 10, now: () => t, onRelease: () => { throw new Error("x"); } });
  await q.run("lane:a", async () => {});
  await q.run("lane:b", async () => {});
  t = 100;
  assert.deepEqual(q.sweep().sort(), ["lane:a", "lane:b"]);
});
