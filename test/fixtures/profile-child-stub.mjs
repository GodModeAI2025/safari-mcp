// Stand-in for a safari-mcp child in profile-router tests: reports which profile it serves.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "profile-child-stub", version: "0.0.0" });
server.tool("safari_whoami", "which profile and process serve this call", { note: z.string().optional() }, async ({ note }) => ({
  content: [{ type: "text", text: JSON.stringify({ profile: process.env.SAFARI_PROFILE ?? null, pid: process.pid, note: note ?? null, http: process.env.SAFARI_MCP_HTTP ?? null }) }],
}));
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => process.exit(0));
