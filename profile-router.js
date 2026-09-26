#!/usr/bin/env node
// Profile router — choose the Safari profile per tool call (#26).
//
//   SAFARI_MCP_PROFILES="Work,Personal" npx safari-mcp-profiles
//
// Every tool gains an optional `safariProfile` argument (not `profile`: safari_throttle_network
// already uses that name for its network profile). The router runs one ordinary safari-mcp
// child per profile (SAFARI_PROFILE=<name>, the mode that already exists and is proven) and
// forwards each call to the child for the requested profile. Calls without `safariProfile` go to
// SAFARI_MCP_DEFAULT_PROFILE, or to your ordinary Safari windows when that is unset.
//
// WHY a router and not a per-call switch inside one process: a named profile is not just a
// window filter. It decides which extension worker the host verifies, which one holds the
// bridge lease, and that the profile runs extension-only. Swapping that per call inside one
// process would put two profiles' state in the same maps; one child per profile keeps every
// one of those guarantees exactly as they are.
//
// Isolation: each MCP session of the router gets its OWN children (spawned lazily, on first
// use of a profile), so two agents on one router never share a child session — the #76
// collapse cannot happen here. Children are stdio processes and exit when the router closes
// their stdin, which it does when the session ends.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { startTransport } from "./transport.js";
import { currentSessionId } from "./session-context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY = ""; // ordinary Safari windows (no SAFARI_PROFILE)

// Pure: env -> router plan. Throws on a config it cannot serve rather than guessing.
export function planProfiles(env = {}) {
  const profiles = [...new Set(String(env.SAFARI_MCP_PROFILES || "").split(",").map((p) => p.trim()).filter(Boolean))];
  if (!profiles.length) throw new Error("SAFARI_MCP_PROFILES is empty — list the Safari profile names, comma-separated");
  for (const p of profiles) {
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (p.length > 100 || /[\u0000-\u001f"\\]/.test(p)) throw new Error(`invalid profile name ${JSON.stringify(p)}`);
  }
  const def = (env.SAFARI_MCP_DEFAULT_PROFILE || "").trim();
  if (def && !profiles.includes(def)) {
    throw new Error(`SAFARI_MCP_DEFAULT_PROFILE "${def}" is not in SAFARI_MCP_PROFILES (${profiles.join(", ")})`);
  }
  return { profiles, defaultProfile: def || DEFAULT_KEY };
}

// Pure: which child a call goes to. `undefined` means "the default"; an unknown name is refused
// rather than silently served by the default profile's windows.
export function resolveProfile(requested, plan) {
  if (requested === undefined || requested === null || requested === "") return plan.defaultProfile;
  if (!plan.profiles.includes(requested)) {
    throw new Error(`Unknown profile "${requested}". Configured: ${plan.profiles.join(", ")}`);
  }
  return requested;
}

// Pure: child tool schema + the router's `safariProfile` argument.
export const PROFILE_ARG = "safariProfile";
export function withProfileArg(tool, plan) {
  const schema = tool.inputSchema || { type: "object", properties: {} };
  if (schema.properties && PROFILE_ARG in schema.properties) {
    throw new Error(`tool ${tool.name} already declares a "${PROFILE_ARG}" argument`);
  }
  const fallback = plan.defaultProfile ? `"${plan.defaultProfile}"` : "your ordinary Safari windows";
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties || {}),
        [PROFILE_ARG]: {
          type: "string",
          enum: plan.profiles,
          description: `Safari profile to run this call in (default: ${fallback}). Tabs, receipts and ownership are per profile.`,
        },
      },
    },
  };
}

// Pure: the environment a child runs with. Router-only settings are stripped so a child can
// never become a router or an HTTP daemon itself.
export function childEnv(base, profileKey) {
  const env = { ...base };
  delete env.SAFARI_MCP_PROFILES;
  delete env.SAFARI_MCP_DEFAULT_PROFILE;
  delete env.SAFARI_MCP_HTTP;
  delete env.SAFARI_MCP_HTTP_PORT;
  if (profileKey) env.SAFARI_PROFILE = profileKey;
  else delete env.SAFARI_PROFILE;
  return env;
}

export function createProfileRouter({
  env = process.env,
  childCommand = env.SAFARI_MCP_PROFILE_CHILD ? [process.execPath, env.SAFARI_MCP_PROFILE_CHILD] : [process.execPath, join(HERE, "index.js")],
} = {}) {
  const plan = planProfiles(env);
  const sessions = new Map(); // router session id -> Map<profileKey, Promise<{client, transport}>>
  let toolsCache = null;

  function spawn(profileKey) {
    const transport = new StdioClientTransport({
      command: childCommand[0],
      args: childCommand.slice(1),
      env: childEnv(env, profileKey),
      stderr: "inherit",
    });
    const client = new Client({ name: "safari-mcp-profile-router", version: "0.0.0" });
    return client.connect(transport, { timeout: 30_000 }).then(() => ({ client, transport }));
  }

  function childFor(sessionId, profileKey) {
    let children = sessions.get(sessionId);
    if (!children) sessions.set(sessionId, (children = new Map()));
    if (!children.has(profileKey)) {
      const p = spawn(profileKey);
      p.catch(() => children.delete(profileKey)); // a failed spawn may be retried by the next call
      children.set(profileKey, p);
    }
    return children.get(profileKey);
  }

  async function listTools() {
    if (!toolsCache) {
      // Schemas are identical across profiles; ask the default child of whoever asks first.
      const { client } = await childFor(currentSessionId(), plan.defaultProfile);
      const { tools } = await client.listTools();
      toolsCache = tools.map((t) => withProfileArg(t, plan));
    }
    return toolsCache;
  }

  async function closeSession(sessionId) {
    const children = sessions.get(sessionId);
    if (!children) return;
    sessions.delete(sessionId);
    await Promise.all(
      [...children.values()].map((p) => p.then(({ client }) => client.close()).catch(() => {}))
    );
  }

  function buildServer() {
    const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
    const server = new Server(
      { name: "safari-mcp", version: pkg.version, description: `Safari automation across profiles: ${plan.profiles.join(", ")}` },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { [PROFILE_ARG]: requested, ...args } = req.params.arguments || {};
      let key;
      try {
        key = resolveProfile(requested, plan);
      } catch (e) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
      const { client } = await childFor(currentSessionId(), key);
      return client.callTool({ name: req.params.name, arguments: args });
    });
    // stdio has one session for the life of the process; tie the children to it.
    const sid = currentSessionId();
    server.onclose = () => { void closeSession(sid); };
    return server;
  }

  return {
    plan,
    buildServer,
    closeSession,
    get sessionCount() { return sessions.size; },
    async closeAll() { await Promise.all([...sessions.keys()].map(closeSession)); },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const router = createProfileRouter();
  const handle = await startTransport(router.buildServer, process.env, {
    // In HTTP mode each MCP session owns its children; release them with the session.
    dropSession: (id) => { void router.closeSession(id); },
  });
  const shutdown = async () => {
    await router.closeAll().catch(() => {});
    await handle.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (handle.kind === "stdio") {
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
  }
  console.error(`[Safari MCP] profile router: ${router.plan.profiles.join(", ")} (default: ${router.plan.defaultProfile || "ordinary windows"})`);
}

