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

// Per-key FIFO. Each call chains onto the previous call's settlement (success OR failure), so
// one failing call never wedges its lane, and the map entry is dropped once the lane is idle.
export function createLaneQueue() {
  const tails = new Map();
  return {
    run(key, fn) {
      const prev = tails.get(key) || Promise.resolve();
      const result = prev.then(() => fn());
      const tail = result.then(
        () => {},
        () => {}
      );
      tails.set(key, tail);
      tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    get size() {
      return tails.size;
    },
  };
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
