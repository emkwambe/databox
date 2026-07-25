import type {
  RealityDBConfig,
  ClaimDatabaseParams,
  ClaimedDatabase,
  Pack,
  Quota,
} from "./types.js";

// The Claimable Database Agent API production base URL. Override with
// REALITYDB_BASE_URL (passed through as config.baseUrl).
export const DEFAULT_BASE_URL = "https://lab.realitydb.dev";

/**
 * Thin client over the RealityDB /v1/agent/* endpoints. Normalizes the
 * API's self-describing response shapes into the MCP-facing types and
 * surfaces API error codes as descriptive Error messages.
 */
export class RealityDBClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: RealityDBConfig) {
    if (!config.apiKey) throw new Error("RealityDBClient requires an apiKey");
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err: any) {
      throw new Error(`[network_error] Could not reach ${this.baseUrl}${path}: ${err?.message || err}`);
    }

    const raw = await res.text();
    let json: any = {};
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = { raw };
      }
    }

    if (!res.ok) {
      const code = json.error || `http_${res.status}`;
      const message = json.message || res.statusText || "Request failed";
      const upgrade = json.upgrade_url ? ` Upgrade: ${json.upgrade_url}` : "";
      throw new Error(`[${code}] ${message}${upgrade}`);
    }

    return json;
  }

  async claimDatabase(params: ClaimDatabaseParams): Promise<ClaimedDatabase> {
    // Map MCP-facing names (pack/ttl) onto the API's field names.
    const body: Record<string, unknown> = { template: params.pack };
    if (params.rows !== undefined) body.rows = params.rows;
    if (params.ttl !== undefined) body.ttl_seconds = params.ttl;
    if (params.seed !== undefined) body.seed = params.seed;
    if (params.idempotencyKey !== undefined) body.idempotency_key = params.idempotencyKey;

    const r = await this.request("POST", "/v1/agent/databases", body);
    return this.normalize(r);
  }

  async releaseDatabase(databaseId: string): Promise<void> {
    await this.request("DELETE", `/v1/agent/databases/${encodeURIComponent(databaseId)}`);
  }

  async listDatabases(): Promise<ClaimedDatabase[]> {
    const r = await this.request("GET", "/v1/agent/databases");
    return ((r.databases as any[]) || []).map((d) => this.normalize(d));
  }

  async listPacks(): Promise<Pack[]> {
    const r = await this.request("GET", "/v1/agent/packs");
    return (r.packs as Pack[]) || [];
  }

  async getQuota(): Promise<Quota> {
    return (await this.request("GET", "/v1/agent/quota")) as Quota;
  }

  // Normalize both the claim response (claim_id, connection_string_direct,
  // expires_at_iso8601, ...) and the list-item shape (database_id, rows,
  // ttl_remaining_seconds, ...) into a single ClaimedDatabase.
  private normalize(r: any): ClaimedDatabase {
    const pack = r.template ?? r.pack ?? "";
    return {
      database_id: r.claim_id ?? r.database_id ?? "",
      status: r.status ?? "unknown",
      connection_string: r.connection_string_direct ?? r.connection_string ?? "",
      connection_string_pooled: r.connection_string_pooled ?? "",
      pack,
      rows_seeded: r.rows_seeded ?? r.rows ?? 0,
      seed: r.seed ?? null,
      claimed_at: r.claimed_at ?? r.created_at ?? "",
      expires_at: r.expires_at_iso8601 ?? r.expires_at ?? "",
      ttl_seconds_remaining: r.ttl_seconds_remaining ?? r.ttl_remaining_seconds ?? 0,
      docs_url: r.compliance_doc_url ?? r.docs_url ?? `https://realitydb.dev/docs/packs/${pack}`,
      schema_url: r.schema_url ?? `https://realitydb.dev/docs/packs/${pack}#schema`,
    };
  }
}
