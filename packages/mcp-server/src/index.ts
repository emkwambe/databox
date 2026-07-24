#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { RealityDBClient } from "./client.js";
import type { ToolDefinition } from "./types.js";
import { claimTool } from "./tools/claim.js";
import { releaseTool } from "./tools/release.js";
import { listTool } from "./tools/list.js";
import { packsTool } from "./tools/packs.js";
import { quotaTool } from "./tools/quota.js";

const TOOLS: ToolDefinition[] = [
  claimTool,
  releaseTool,
  listTool,
  packsTool,
  quotaTool,
];

// API key resolution: REALITYDB_API_KEY env var, or --api-key <key> CLI arg.
function resolveApiKey(): string | undefined {
  if (process.env.REALITYDB_API_KEY) return process.env.REALITYDB_API_KEY;
  const idx = process.argv.indexOf("--api-key");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      [
        "Error: REALITYDB_API_KEY environment variable not set.",
        "",
        "Get your API key at realitydb.dev/agent",
        "",
        "Set it with:",
        "export REALITYDB_API_KEY=rdb_agent_...",
      ].join("\n"),
    );
    process.exit(1);
  }

  const client = new RealityDBClient({
    apiKey,
    baseUrl: process.env.REALITYDB_BASE_URL,
  });

  const server = new Server(
    { name: "realitydb-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Advertise the tool catalog (name + JSON Schema) for discovery.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Dispatch a tool call to its handler; surface errors as text content
  // with isError so the agent can read and self-correct.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const text = await tool.handler(client, request.params.arguments ?? {});
      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `❌ ${err?.message || String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Diagnostics go to stderr — stdout is reserved for the JSON-RPC stream.
  console.error("RealityDB MCP Server running");
  console.error(`${TOOLS.length} tools registered:`);
  for (const t of TOOLS) console.error(`  ${t.name}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
