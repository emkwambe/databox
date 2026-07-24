import type { ToolDefinition } from "../types.js";

export const packsTool: ToolDefinition = {
  name: "list_packs",
  description:
    "List all available domain packs with their compliance coverage, row limits, and documentation links.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (client) => {
    const packs = await client.listPacks();
    if (packs.length === 0) return "No domain packs available.";

    const blocks = packs.map((p) => {
      const compliance = p.compliance && p.compliance.length ? p.compliance.join(", ") : "none";
      return [
        `• ${p.id} — ${p.name}`,
        `    ${p.description}`,
        `    Tables: ${p.tables} | Rows: ${p.min_rows}–${p.max_rows} (default ${p.default_rows})`,
        `    Compliance: ${compliance}`,
        `    Docs: ${p.docs_url}`,
      ].join("\n");
    });

    return [`${packs.length} domain pack${packs.length === 1 ? "" : "s"} available:`, "", ...blocks].join("\n");
  },
};
