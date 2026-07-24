import type { ToolDefinition } from "../types.js";

// Best-known primary table per pack, used only to render a runnable
// quick-start snippet. Falls back to a generic hint.
const PACK_FIRST_TABLE: Record<string, string> = {
  "us-banking": "accounts",
  "banking": "accounts",
  "eu-banking": "accounts",
  "us-healthcare": "patients",
  "healthcare": "patients",
  "oncology": "patients",
  "eu-healthcare": "patients",
  "us-telecom": "subscribers",
  "telecom": "subscribers",
  "eu-telecom": "subscribers",
  "us-insurance": "policies",
  "fintech": "users",
  "supply-chain": "suppliers",
  "aml": "entities",
  "universal": "records",
};

export const claimTool: ToolDefinition = {
  name: "claim_database",
  description:
    "Provision a live PostgreSQL database seeded with realistic synthetic data from a specific domain. Returns a connection string immediately usable for SQL queries. The database auto-deletes after the TTL expires.",
  inputSchema: {
    type: "object",
    properties: {
      pack: {
        type: "string",
        description: "Domain pack ID. Use list_packs to see available options.",
        enum: [
          "us-banking",
          "us-healthcare",
          "us-telecom",
          "us-insurance",
          "eu-banking",
          "fintech",
          "supply-chain",
        ],
      },
      rows: {
        type: "number",
        description: "Number of rows to generate. Default: 5000. Must be within tier limits.",
        minimum: 100,
        maximum: 500000,
      },
      ttl: {
        type: "number",
        description: "Time to live in seconds before auto-deletion. Default: 3600 (1 hour).",
        minimum: 300,
        maximum: 2592000,
      },
      seed: {
        type: "number",
        description:
          "Optional seed for deterministic generation. Same seed always produces identical data. Useful for reproducible tests.",
      },
    },
    required: ["pack"],
  },
  handler: async (client, args) => {
    const pack = String(args.pack ?? "");
    if (!pack) throw new Error("pack is required");

    const db = await client.claimDatabase({
      pack,
      rows: args.rows as number | undefined,
      ttl: args.ttl as number | undefined,
      seed: args.seed as number | undefined,
      idempotencyKey: args.idempotency_key as string | undefined,
    });

    const firstTable = PACK_FIRST_TABLE[db.pack] || "your_table";

    return [
      "✅ Database ready",
      "",
      `Pack: ${db.pack} (${db.rows_seeded} rows)`,
      `Connection: ${db.connection_string || db.connection_string_pooled}`,
      `Expires: ${db.expires_at} (${db.ttl_seconds_remaining} seconds)`,
      `Database ID: ${db.database_id}`,
      "",
      "Quick start:",
      `  psql "${db.connection_string || db.connection_string_pooled}"`,
      `  SELECT * FROM ${firstTable} LIMIT 5;`,
      "",
      `Docs: ${db.docs_url}`,
    ].join("\n");
  },
};
