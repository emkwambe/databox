import type { RealityDBClient } from "./client.js";

export interface RealityDBConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface ClaimDatabaseParams {
  pack: string;
  rows?: number;
  ttl?: number;
  seed?: number;
  idempotencyKey?: string;
}

export interface ClaimedDatabase {
  database_id: string;
  status: string;
  connection_string: string;
  connection_string_pooled: string;
  pack: string;
  rows_seeded: number;
  seed: number | null;
  claimed_at: string;
  expires_at: string;
  ttl_seconds_remaining: number;
  docs_url: string;
  schema_url: string;
}

export interface Pack {
  id: string;
  name: string;
  description: string;
  tables: number;
  max_rows: number;
  min_rows: number;
  default_rows: number;
  compliance: string[];
  docs_url: string;
}

export interface Quota {
  plan: string;
  databases_this_period: number;
  databases_limit: number;
  concurrent_active: number;
  concurrent_limit: number;
  max_rows_per_claim: number;
  max_ttl_seconds: number;
  period_reset_at: string;
}

// A single MCP tool: its JSON-Schema-described input and a handler that
// turns validated args into a human-readable text result.
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: RealityDBClient, args: Record<string, unknown>) => Promise<string>;
}
