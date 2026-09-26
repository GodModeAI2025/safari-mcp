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
import { planProfiles, resolveProfile, withProfileArg, childEnv, createProfileRouter } from "../profile-router.js";

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

async function routerOverHttp(env) {
  const router = createProfileRouter({ env: { ...process.env, ...env }, childCommand: [process.execPath, STUB] });
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
