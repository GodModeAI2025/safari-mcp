// Opt-in explicit lanes (SAFARI_MCP_LANES=1) — one process, many isolated agents (#76).
//
// WHY: per-session isolation keys off the MCP session id, so it only engages when every agent
// reaches the server as its own MCP client. Runners that cache ONE client per server name
// (mcporter keep-alive, and any similar pooling layer) collapse N agents into one session id,
// so every agent shares one tab pointer — the #76 collapse, invisible from the server side.
// A lane is the agent naming itself: with the flag set, every tool takes a required `laneId`,
// and the handler runs inside sessionCtx under `lane:<laneId>`. That reuses the exact
// per-session state safari.js already keeps (tab pointer, ownership, marker) and the composite
// extension id index.js derives from currentSessionId(), so lanes reach the extension bridge
// with no further plumbing.
//
// What lanes add over transport sessions:
//   - re-claim: lane state is keyed by the name the agent chose, not by a transport id, so a
//     reconnect (new Mcp-Session-Id, fresh stdio client) that presents the same laneId is back
//     on its own tab. Transport close never drops lane state.
//   - per-lane serialization: calls into the same lane run one at a time, in arrival order.
//     Different lanes still run concurrently.
//   - fail-closed: with the flag set, a call without a valid laneId is rejected by the schema
//     — there is no default lane to fall into.
//   - idle release: a lane silent for SAFARI_MCP_LANE_IDLE_MS (default 1h, 0 = never) has its
//     server-side state dropped, so client-chosen ids cannot grow the process without bound.
//     Its tab stays open (a stray MCP tab costs nothing; closing the wrong one costs work).
//
// Default off: schemas and behaviour are unchanged unless SAFARI_MCP_LANES=1.

import { z } from "zod";
import { sessionCtx } from "./session-context.js";

export const LANE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LANE_PREFIX = "lane:";

export function lanesEnabled(env = {}) {
  const flag = env.SAFARI_MCP_LANES;
  return Boolean(flag && flag !== "0");
}

export function laneSessionKey(laneId) {
  return LANE_PREFIX + laneId;
}

export function isLaneSessionKey(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith(LANE_PREFIX);
}

export const laneIdSchema = z
  .string()
  .regex(LANE_ID_PATTERN, "laneId must be 1-128 chars of [A-Za-z0-9._:-]")
  .describe(
    "Lane id (required: SAFARI_MCP_LANES=1). Every call with the same laneId shares one tab/ownership state and runs serialized; use one stable id per agent."
  );

// Default idle window before a lane's state is released. Long on purpose: releasing a lane
// ends its ability to re-claim its tab, so it should only catch lanes that are truly gone.
export const DEFAULT_LANE_IDLE_MS = 60 * 60 * 1000;

export function laneIdleMs(env = {}) {
  const raw = env.SAFARI_MCP_LANE_IDLE_MS;
  if (raw === undefined || raw === "") return DEFAULT_LANE_IDLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LANE_IDLE_MS; // 0 = never release
}

// Per-key FIFO. Each call chains onto the previous call's settlement (success OR failure), so
// one failing call never wedges its lane, and the chain entry is dropped once the lane is idle.
//
// It also remembers when each lane was last active, so lanes that stop calling can have their
// server-side state released by sweep(). Lane ids are chosen by clients, so without this every
// id ever seen would pin a state entry for the life of the process. A lane is only released
// when nothing of it is queued or running, and only after `idleMs` of silence.
//
// A released lane that calls again must not come back as a lane that never owned a tab: that
// state acts on the user's front tab. Released keys are remembered (bounded) and `onRevive`
// fires before the lane's next call, so the host can restore it as "owned a tab, lost it" —
// every op then fails closed until safari_new_tab.
export const RELEASED_LANES_CAP = 10000;
export function createLaneQueue({ idleMs = 0, onRelease = () => {}, onRevive = () => {}, now = Date.now } = {}) {
  const tails = new Map();
  const tombstones = new Set(); // released lane keys; insertion-ordered, oldest evicted first
  const lastActive = new Map();
  const running = new Map();
  const bump = (key, d) => {
    const n = (running.get(key) || 0) + d;
    if (n > 0) running.set(key, n);
    else running.delete(key);
  };
  const queue = {
    run(key, fn) {
      if (tombstones.delete(key)) {
        try { onRevive(key); } catch { /* reviving is best-effort; the op guards still apply */ }
      }
      lastActive.set(key, now());
      bump(key, 1);
      const prev = tails.get(key) || Promise.resolve();
      const result = prev.then(() => fn());
      // Settle bookkeeping runs in the first reaction to `result`, ahead of the caller's own
      // continuation, so a caller that awaited run() never sees its lane still "running".
      const settle = () => {
        bump(key, -1);
        lastActive.set(key, now());
      };
      const tail = result.then(settle, settle);
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    // Releases every lane idle for at least idleMs. Returns the released keys.
    sweep() {
      if (!(idleMs > 0)) return [];
      const t = now();
      const released = [];
      for (const [key, at] of lastActive) {
        if (running.has(key) || t - at < idleMs) continue;
        lastActive.delete(key);
        try { onRelease(key); } catch { /* releasing is best-effort */ }
        tombstones.add(key);
        if (tombstones.size > RELEASED_LANES_CAP) tombstones.delete(tombstones.values().next().value);
        released.push(key);
      }
      return released;
    },
    // Sweeps periodically without keeping the process alive. Returns a stop function.
    startSweeper(everyMs = Math.min(Math.max(idleMs / 4, 1000), 60_000)) {
      if (!(idleMs > 0)) return () => {};
      const timer = setInterval(() => queue.sweep(), everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    get size() {
      return tails.size;
    },
    get lanes() {
      return lastActive.size;
    },
  };
  return queue;
}

// Wraps server.tool so every registration grows a required laneId and runs inside its lane.
// Supports the SDK's positional forms: (name, shape, cb), (name, desc, shape, cb) and
// (name, desc, shape, annotations, cb). A tool registered without a shape gets one.
export function applyLanes(server, { queue = createLaneQueue() } = {}) {
  const register = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const cb = rest.pop();
    if (typeof cb !== "function") throw new Error(`lanes: tool ${name} registered without a handler`);
    const shapeAt = typeof rest[0] === "string" ? 1 : 0;
    const shape = rest[shapeAt] && typeof rest[shapeAt] === "object" ? rest[shapeAt] : {};
    if ("laneId" in shape) throw new Error(`lanes: tool ${name} already declares laneId`);
    const args = [...rest];
    args[shapeAt] = { ...shape, laneId: laneIdSchema };
    const wrapped = async (input, extra) => {
      const { laneId, ...toolArgs } = input || {};
      // The schema already enforces this; re-check so a handler can never run laneless.
      if (typeof laneId !== "string" || !LANE_ID_PATTERN.test(laneId)) {
        throw new Error("SAFARI_MCP_LANES=1: every tool call needs a valid laneId");
      }
      const key = laneSessionKey(laneId);
      return queue.run(key, () => sessionCtx.run({ sessionId: key }, () => cb(toolArgs, extra)));
    };
    return register(name, ...args, wrapped);
  };
  return server;
}
