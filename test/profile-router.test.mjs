#!/usr/bin/env node
/**
 * #26 — choose the Safari profile per call. The router runs one ordinary safari-mcp child per
 * profile (SAFARI_PROFILE=<name>) and forwards each call by its `safariProfile` argument. The child
 * here is a stub that reports the profile it was started for, so routing is observable on
 * Linux CI without Safari.
 */
import assert from "node:assert";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTransport } from "../transport.js";
import { planProfiles, resolveProfile, withProfileArg, childEnv, createProfileRouter, isMainModule, forwardTimeoutMs, FORWARD_TIMEOUT_FLOOR_MS } from "../profile-router.js";
import { mkdtempSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STUB = fileURLToPath(new URL("./fixtures/profile-child-stub.mjs", import.meta.url));

test("plan: profiles are parsed, deduplicated, and a bad default is refused", () => {
  assert.deepEqual(planProfiles({ SAFARI_MCP_PROFILES: " Work, Personal ,Work" }), { profiles: ["Work", "Personal"], defaultProfile: "" });
  assert.equal(planProfiles({ SAFARI_MCP_PROFILES: "Work,Personal", SAFARI_MCP_DEFAULT_PROFILE: "Personal" }).defaultProfile, "Personal");
  assert.throws(() => planProfiles({}), /SAFARI_MCP_PROFILES is empty/);
  assert.throws(() => planProfiles({ SAFARI_MCP_PROFILES: "Work", SAFARI_MCP_DEFAULT_PROFILE: "Other" }), /not in SAFARI_MCP_PROFILES/);
  assert.throws(() => planProfiles({ SAFARI_MCP_PROFILES: 'bad"name' }), /invalid profile name/);
});

test("resolve: absent profile goes to the default, an unknown one is refused (never served by another profile)", () => {
  const plan = { profiles: ["Work", "Personal"], defaultProfile: "" };
  assert.equal(resolveProfile(undefined, plan), "");
  assert.equal(resolveProfile("", plan), "");
  assert.equal(resolveProfile("Work", plan), "Work");
  assert.throws(() => resolveProfile("work", plan), /Unknown profile "work"/);
});

test("schema: every tool gains an optional safariProfile enum; a clash is an error, not an override", () => {
  const plan = { profiles: ["Work", "Personal"], defaultProfile: "Work" };
  const t = withProfileArg({ name: "x", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }, plan);
  assert.deepEqual(t.inputSchema.properties.safariProfile.enum, ["Work", "Personal"]);
  assert.deepEqual(t.inputSchema.required, ["url"], "safariProfile must stay optional");
  assert.match(t.inputSchema.properties.safariProfile.description, /default: "Work"/);
  assert.throws(() => withProfileArg({ name: "y", inputSchema: { type: "object", properties: { safariProfile: {} } } }, plan), /already declares/);
});

test("child env: router-only and daemon settings never reach a child", () => {
  const base = { PATH: "/bin", SAFARI_MCP_PROFILES: "A,B", SAFARI_MCP_DEFAULT_PROFILE: "A", SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "9225", SAFARI_PROFILE: "stale", SAFARI_MCP_LANES: "1" };
  const a = childEnv(base, "A");
  assert.equal(a.SAFARI_PROFILE, "A");
  for (const k of ["SAFARI_MCP_PROFILES", "SAFARI_MCP_DEFAULT_PROFILE", "SAFARI_MCP_HTTP", "SAFARI_MCP_HTTP_PORT"]) assert.ok(!(k in a), k);
  assert.equal(a.SAFARI_MCP_LANES, "1", "lanes pass through: the child enforces laneId");
  assert.ok(!("SAFARI_PROFILE" in childEnv(base, "")), "the default child runs on ordinary windows");
});

async function routerOverHttp(env, opts = {}) {
  const router = createProfileRouter({ env: { ...process.env, ...env }, childCommand: [process.execPath, STUB], ...opts });
  const handle = await startTransport(router.buildServer, { SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "0" }, {
    dropSession: (id) => { void router.closeSession(id); },
  });
  const connect = async () => {
    const client = new Client({ name: "agent", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
    await client.connect(transport);
    return { client, transport };
  };
  return { router, handle, connect };
}
const who = async (client, args = {}) => {
  const res = await client.callTool({ name: "safari_whoami", arguments: args });
  return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
};

test("calls are routed to the child for the requested profile", { timeout: 60_000 }, async () => {
  const { router, handle, connect } = await routerOverHttp({ SAFARI_MCP_PROFILES: "Work,Personal" });
  const { client } = await connect();
  try {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "safari_whoami");
    assert.deepEqual(tool.inputSchema.properties.safariProfile.enum, ["Work", "Personal"]);

    const def = await who(client, { note: "n" });
    const work = await who(client, { safariProfile: "Work" });
    const personal = await who(client, { safariProfile: "Personal" });
    assert.equal(def.profile, null, "no profile → ordinary windows");
    assert.equal(def.note, "n", "arguments are forwarded, minus `safariProfile`");
    assert.equal(work.profile, "Work");
    assert.equal(personal.profile, "Personal");
    assert.equal(work.http, null, "a child never runs as an HTTP daemon");
    assert.equal(new Set([def.pid, work.pid, personal.pid]).size, 3, "one child per profile");
    assert.equal((await who(client, { safariProfile: "Work" })).pid, work.pid, "the same child serves later calls");

    const bad = await who(client, { safariProfile: "Nope" });
    assert.match(bad.error, /Unknown profile "Nope"/);
  } finally {
    await client.close();
    await router.closeAll();
    await handle.close();
  }
});

test("two router sessions never share a child — no #76-style collapse", { timeout: 60_000 }, async () => {
  const { router, handle, connect } = await routerOverHttp({ SAFARI_MCP_PROFILES: "Work", SAFARI_MCP_DEFAULT_PROFILE: "Work" });
  const a = await connect();
  const b = await connect();
  try {
    const [wa, wb] = await Promise.all([who(a.client), who(b.client)]);
    assert.equal(wa.profile, "Work");
    assert.equal(wb.profile, "Work");
    assert.notEqual(wa.pid, wb.pid, "each session gets its own child");
    assert.equal(router.sessionCount, 2);

    await a.transport.terminateSession();
    await a.client.close();
    for (let i = 0; i < 50 && router.sessionCount !== 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(router.sessionCount, 1, "a closed session releases its children");
  } finally {
    await b.client.close();
    await router.closeAll();
    await handle.close();
  }
});

test("the router argument cannot collide with a real tool argument", async () => {
  const { readFileSync } = await import("node:fs");
  const idx = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.ok(!/\bsafariProfile\s*:/.test(idx), "a tool declares safariProfile — rename the router argument");
});

const ROUTER = fileURLToPath(new URL("../profile-router.js", import.meta.url));

test("isMainModule sees through the npm .bin symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-mcp-bin-"));
  try {
    const link = join(dir, "safari-mcp-profiles");
    symlinkSync(ROUTER, link);
    const url = new URL("../profile-router.js", import.meta.url).href;
    assert.equal(isMainModule(url, link), true, "a symlinked launch must count as main");
    assert.equal(isMainModule(url, ROUTER), true);
    assert.equal(isMainModule(url, fileURLToPath(new URL("../index.js", import.meta.url))), false);
    assert.equal(isMainModule(url, undefined), false);
    assert.equal(isMainModule(url, join(dir, "missing")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launched through a symlink (as npx does), the router actually serves", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "safari-mcp-bin-"));
  const link = join(dir, "safari-mcp-profiles");
  symlinkSync(ROUTER, link);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [link],
    env: { ...process.env, SAFARI_MCP_PROFILES: "Work", SAFARI_MCP_PROFILE_CHILD: STUB },
    stderr: "pipe",
  });
  const client = new Client({ name: "npx-like", version: "0.0.0" });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const out = await who(client, { safariProfile: "Work" });
    assert.equal(out.profile, "Work");
  } finally {
    await client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that dies after connecting is replaced on the next call", { timeout: 60_000 }, async () => {
  const { router, handle, connect } = await routerOverHttp({ SAFARI_MCP_PROFILES: "Work" });
  const { client } = await connect();
  try {
    const first = await who(client, { safariProfile: "Work" });
    process.kill(first.pid, "SIGKILL");
    let second;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      second = await who(client, { safariProfile: "Work" }).catch((e) => ({ error: String(e) }));
      if (second.pid) break;
    }
    assert.ok(second.pid, `profile stayed dead: ${JSON.stringify(second)}`);
    assert.notEqual(second.pid, first.pid, "a fresh child must serve the profile");
    assert.equal(second.profile, "Work");
  } finally {
    await client.close();
    await router.closeAll();
    await handle.close();
  }
});

test("forwarded calls outlive the SDK's 60s default and the child's own budget", () => {
  assert.equal(FORWARD_TIMEOUT_FLOOR_MS, 600000);
  assert.equal(forwardTimeoutMs({}), 600000);
  assert.equal(forwardTimeoutMs({ timeout: 90000 }), 600000, "safari_navigate { timeout: 90000 } fits the floor");
  assert.equal(forwardTimeoutMs({ timeout: 300000 }), 300000 * 4 + 60000, "long caller timeouts scale past the floor");
  assert.equal(forwardTimeoutMs({ timeout: "abc" }), 600000);
  const src = readFileSync(ROUTER, "utf8");
  assert.match(src, /client\.callTool\(\{ name: req\.params\.name, arguments: args \}, undefined, \{\n\s*timeout: forwardTimeoutMs\(args\),/);
  assert.match(src, /signal: extra\?\.signal/);
});

test("HTTP router: sessions beyond the cap are refused instead of spawning more children", { timeout: 60_000 }, async () => {
  const { router, handle, connect } = await routerOverHttp({ SAFARI_MCP_PROFILES: "Work", SAFARI_MCP_DEFAULT_PROFILE: "Work" }, { maxSessions: 1 });
  const a = await connect();
  const b = await connect();
  try {
    assert.equal((await who(a.client)).profile, "Work");
    const refused = await who(b.client);
    assert.match(refused.error, /session limit \(1\)/);
    assert.equal(router.sessionCount, 1, "no child was spawned for the refused session");
  } finally {
    await a.client.close();
    await b.client.close();
    await router.closeAll();
    await handle.close();
  }
});

test("HTTP router: idle sessions release their children; stdio routers never expire", { timeout: 60_000 }, async () => {
  let t = 0;
  const { router, handle, connect } = await routerOverHttp(
    { SAFARI_MCP_PROFILES: "Work", SAFARI_MCP_DEFAULT_PROFILE: "Work" },
    { idleMs: 1000, now: () => t }
  );
  const { client } = await connect();
  try {
    const first = await who(client);
    t = 500;
    assert.deepEqual(await router.sweepIdle(), [], "not idle yet");
    t = 5000;
    assert.equal((await router.sweepIdle()).length, 1);
    assert.equal(router.sessionCount, 0);
    const again = await who(client);
    assert.notEqual(again.pid, first.pid, "the next call gets a fresh child");
  } finally {
    await client.close();
    await router.closeAll();
    await handle.close();
  }
  const stdio = createProfileRouter({ env: { SAFARI_MCP_PROFILES: "Work" }, childCommand: [process.execPath, STUB] });
  assert.deepEqual(await stdio.sweepIdle(), [], "idle expiry is off without SAFARI_MCP_HTTP");
  stdio.stop();
});
