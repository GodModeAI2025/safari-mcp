#!/usr/bin/env node
/**
 * Session cardinality & continuity across the client stack (#84, spun off #76).
 *
 * "Per-session isolation" is only true if every hop upstream keeps agents distinct all the way
 * to the server. #76 collapsed at a hop the server cannot see: a runner that caches ONE MCP
 * client per server name (mcporter keep-alive) turned N agents into one Mcp-Session-Id, so the
 * per-session tab state never engaged while every component claim stayed individually true.
 *
 * These tests put a runner in the loop — the real, lockfile-pinned SDK client over
 * StreamableHTTP against the real transport.js — and read the identity chain through the
 * transport's observer hook at the server edge:
 *
 *   agent -> runner -> client instance -> Mcp-Session-Id -> state key -> tab owner
 *
 * Invariants:
 *   1. N concurrent agents with their own clients => N distinct session ids / state keys.
 *   2. One agent's sequential calls stay on ONE session (no fan-out).
 *   3. Reconnect never inherits another session's ownership; only an explicit lane re-claims.
 *   4. A daemon restart cannot leak the previous owner's state; stale ids get 404.
 *   5. A client-caching runner (the #76 mechanism) is detected as a collapse, and lanes
 *      (SAFARI_MCP_LANES=1) restore N distinct state keys through that single client, with
 *      same-lane calls serialized.
 *
 * Run:  node --test --test-force-exit test/session-cardinality.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startTransport } from "../transport.js";
import { currentSessionId } from "../session-context.js";
import { applyLanes, createLaneQueue } from "../lanes.js";

const HTTP = { SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "0" };

// A daemon stand-in: its tab ownership is keyed exactly like safari.js keys _sessions —
// by currentSessionId(). `owners` dies with the "process", as a real restart's would.
async function startDaemon({ lanes = false } = {}) {
  const owners = new Map();
  const seen = { initialized: [], requests: [], closed: [] };
  const queue = createLaneQueue();
  const inflight = new Map();
  const peak = new Map();
  const build = () => {
    const server = new McpServer({ name: "cardinality-stub", version: "0.0.0" });
    if (lanes) applyLanes(server, { queue });
    server.tool("whoami", "state key this call runs under", {}, async () => ({
      content: [{ type: "text", text: currentSessionId() }],
    }));
    server.tool("claim", "own a tab", { tab: z.string() }, async ({ tab }) => {
      owners.set(currentSessionId(), tab);
      return { content: [{ type: "text", text: tab }] };
    });
    server.tool("owner", "the tab this state key owns", {}, async () => ({
      content: [{ type: "text", text: owners.get(currentSessionId()) ?? "(none)" }],
    }));
    server.tool("slow", "records concurrency per state key", { ms: z.number() }, async ({ ms }) => {
      const key = currentSessionId();
      const n = (inflight.get(key) || 0) + 1;
      inflight.set(key, n);
      peak.set(key, Math.max(peak.get(key) || 0, n));
      await new Promise((r) => setTimeout(r, ms));
      inflight.set(key, inflight.get(key) - 1);
      return { content: [{ type: "text", text: key }] };
    });
    return server;
  };
  const handle = await startTransport(build, HTTP, {
    observer: {
      onSessionInitialized: (id) => seen.initialized.push(id),
      onRequest: (id) => seen.requests.push(id),
      onSessionClosed: (id) => seen.closed.push(id),
    },
  });
  return { handle, seen, owners, peak, url: new URL(`http://127.0.0.1:${handle.port}/mcp`) };
}

async function newClient(url, name = "agent") {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

const text = (res) => res.content[0].text;
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }).then(text);

// Runner models. `perAgent` is what per-session isolation assumes; `cachedByServerName` is the
// mcporter keep-alive shape that collapsed #76 — one client per configured server, for everyone.
function perAgentRunner(url) {
  const clients = new Map();
  return {
    async call(agent, name, args) {
      if (!clients.has(agent)) clients.set(agent, newClient(url, agent));
      return call((await clients.get(agent)).client, name, args);
    },
    async close() { for (const c of clients.values()) await (await c).client.close(); },
  };
}
function cachedByServerNameRunner(url) {
  let shared;
  return {
    async call(_agent, name, args) {
      shared ??= newClient(url, "cached");
      return call((await shared).client, name, args);
    },
    async close() { if (shared) await (await shared).client.close(); },
  };
}

const AGENTS = ["a", "b", "c", "d", "e"];

test("N concurrent agents => N distinct Mcp-Session-Ids and state keys", async () => {
  const d = await startDaemon();
  const runner = perAgentRunner(d.url);
  try {
    const keys = await Promise.all(AGENTS.map((a) => runner.call(a, "whoami")));
    assert.equal(new Set(keys).size, AGENTS.length, "two agents converged on one state key");
    assert.equal(new Set(d.seen.initialized).size, AGENTS.length, "server issued fewer sessions than agents");
    for (const k of keys) assert.ok(d.seen.initialized.includes(k), "state key must be the issued session id");
    // Concurrent claims land on each agent's own key, never on a neighbour's.
    await Promise.all(AGENTS.map((a) => runner.call(a, "claim", { tab: `tab-${a}` })));
    const owned = await Promise.all(AGENTS.map((a) => runner.call(a, "owner")));
    assert.deepEqual(owned, AGENTS.map((a) => `tab-${a}`));
  } finally {
    await runner.close();
    await d.handle.close();
  }
});

test("one agent's sequential calls stay on ONE session", async () => {
  const d = await startDaemon();
  const { client } = await newClient(d.url);
  try {
    const keys = [];
    for (let i = 0; i < 8; i++) keys.push(await call(client, "whoami"));
    assert.equal(new Set(keys).size, 1, "sequential calls fanned out across state keys");
    assert.equal(d.seen.initialized.length, 1, "one client must initialize exactly one session");
    assert.ok(d.seen.requests.every((id) => id === keys[0]), "every routed request must carry the one session id");
  } finally {
    await client.close();
    await d.handle.close();
  }
});

test("reconnect never inherits another session's ownership", async () => {
  const d = await startDaemon();
  try {
    const first = await newClient(d.url, "a");
    await call(first.client, "claim", { tab: "tab-a" });
    const firstKey = await call(first.client, "whoami");
    await first.transport.terminateSession();
    await first.client.close();
    assert.ok(d.seen.closed.includes(firstKey), "terminated session must be observed as closed");

    // Meanwhile another agent owns a tab; the reconnecting agent must not land on it either.
    const other = await newClient(d.url, "b");
    await call(other.client, "claim", { tab: "tab-b" });

    const again = await newClient(d.url, "a");
    const againKey = await call(again.client, "whoami");
    assert.notEqual(againKey, firstKey, "a reconnect must mint a new session, not reuse one");
    assert.equal(await call(again.client, "owner"), "(none)", "reconnect silently inherited ownership");
    await again.client.close();
    await other.client.close();
  } finally {
    await d.handle.close();
  }
});

test("daemon restart cannot leak the previous owner's state; stale ids get 404", async () => {
  const d1 = await startDaemon();
  const stale = await newClient(d1.url, "a");
  await call(stale.client, "claim", { tab: "tab-a" });
  const staleId = stale.transport.sessionId;
  await d1.handle.close();

  const d2 = await startDaemon();
  try {
    const res = await fetch(d2.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": staleId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "owner", arguments: {} } }),
    });
    assert.equal(res.status, 404, "a pre-restart session id must be refused, not routed");
    assert.ok(!d2.seen.requests.includes(staleId), "the restarted daemon routed a stale session id");

    const fresh = await newClient(d2.url, "a");
    assert.equal(await call(fresh.client, "owner"), "(none)", "restart leaked the previous owner's state");
    await fresh.client.close();
  } finally {
    await d2.handle.close();
  }
});

test("a client-caching runner collapses N agents into one session (#76 mechanism, detected)", async () => {
  const d = await startDaemon();
  const runner = cachedByServerNameRunner(d.url);
  try {
    const keys = await Promise.all(AGENTS.map((a) => runner.call(a, "whoami")));
    // This is the failure the server cannot see on its own: it is asserted here so a runner
    // that caches clients shows up as ONE session in CI instead of in a user's investigation.
    assert.equal(new Set(keys).size, 1);
    assert.equal(d.seen.initialized.length, 1);
  } finally {
    await runner.close();
    await d.handle.close();
  }
});

test("lanes restore N distinct state keys through a single cached client", async () => {
  const d = await startDaemon({ lanes: true });
  const runner = cachedByServerNameRunner(d.url);
  try {
    const keys = await Promise.all(AGENTS.map((a) => runner.call(a, "whoami", { laneId: `pi-${a}` })));
    assert.equal(d.seen.initialized.length, 1, "precondition: the runner really did collapse the clients");
    assert.equal(new Set(keys).size, AGENTS.length, "lanes must separate agents behind one client");
    await Promise.all(AGENTS.map((a) => runner.call(a, "claim", { laneId: `pi-${a}`, tab: `tab-${a}` })));
    const owned = await Promise.all(AGENTS.map((a) => runner.call(a, "owner", { laneId: `pi-${a}` })));
    assert.deepEqual(owned, AGENTS.map((a) => `tab-${a}`));
  } finally {
    await runner.close();
    await d.handle.close();
  }
});

test("lanes: a call without laneId is refused — no default lane to fall into", async () => {
  const d = await startDaemon({ lanes: true });
  const { client } = await newClient(d.url);
  try {
    const res = await client.callTool({ name: "whoami", arguments: {} }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(res.isError, true, "a laneless call must fail closed");
    const bad = await client.callTool({ name: "whoami", arguments: { laneId: "has space" } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
    assert.equal(bad.isError, true, "a malformed laneId must be refused");
  } finally {
    await client.close();
    await d.handle.close();
  }
});

test("lanes: reconnecting with the same laneId re-claims the lane's ownership explicitly", async () => {
  const d = await startDaemon({ lanes: true });
  try {
    const first = await newClient(d.url);
    await call(first.client, "claim", { laneId: "pi-a", tab: "tab-a" });
    await first.transport.terminateSession();
    await first.client.close();

    const again = await newClient(d.url);
    assert.equal(await call(again.client, "owner", { laneId: "pi-a" }), "tab-a", "same lane must re-claim");
    assert.equal(await call(again.client, "owner", { laneId: "pi-b" }), "(none)", "another lane must not inherit it");
    await again.client.close();
  } finally {
    await d.handle.close();
  }
});

test("lanes: same-lane calls are serialized, different lanes still run concurrently", async () => {
  const d = await startDaemon({ lanes: true });
  const clients = await Promise.all([newClient(d.url), newClient(d.url)]);
  try {
    // Same lane from two different transport sessions: still one at a time.
    await Promise.all(
      [0, 1, 2, 3].map((i) => call(clients[i % 2].client, "slow", { laneId: "shared", ms: 40 }))
    );
    assert.equal(d.peak.get("lane:shared"), 1, "calls into one lane overlapped");

    const t0 = Date.now();
    await Promise.all(["x", "y", "z"].map((l) => call(clients[0].client, "slow", { laneId: l, ms: 150 })));
    assert.ok(Date.now() - t0 < 400, "different lanes must not queue behind each other");
  } finally {
    for (const c of clients) await c.client.close();
    await d.handle.close();
  }
});
