import type { ToolDefinition } from "../types.js";

export const quotaTool: ToolDefinition = {
  name: "check_quota",
  description: "Check your current quota usage and plan limits.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (client) => {
    const q = await client.getQuota();
    const concurrentLimit = q.concurrent_limit < 0 ? "unlimited" : String(q.concurrent_limit);
    const claimsLimit = q.databases_limit < 0 ? "unlimited" : String(q.databases_limit);

    return [
      `Plan: ${q.plan}`,
      "",
      `Databases this period: ${q.databases_this_period} / ${claimsLimit}`,
      `Concurrent active:     ${q.concurrent_active} / ${concurrentLimit}`,
      `Max rows per claim:    ${q.max_rows_per_claim}`,
      `Max TTL per claim:     ${q.max_ttl_seconds} seconds`,
      `Period resets:         ${q.period_reset_at}`,
    ].join("\n");
  },
};
