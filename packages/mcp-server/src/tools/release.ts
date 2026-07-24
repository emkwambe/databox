import type { ToolDefinition } from "../types.js";

export const releaseTool: ToolDefinition = {
  name: "release_database",
  description:
    "Release a claimed database early to free quota. The database will be deleted immediately. This cannot be undone.",
  inputSchema: {
    type: "object",
    properties: {
      database_id: {
        type: "string",
        description: "Database ID returned from claim_database",
      },
      confirm: {
        type: "boolean",
        description: "Must be true to confirm deletion. This action cannot be undone.",
        const: true,
      },
    },
    required: ["database_id", "confirm"],
  },
  handler: async (client, args) => {
    const id = String(args.database_id ?? "");
    if (!id) throw new Error("database_id is required");

    // Human-in-the-loop guard on a destructive op — the caller must
    // explicitly pass confirm: true.
    if (args.confirm !== true) {
      return `⚠️ Refusing to release ${id}: pass confirm: true to permanently delete this database. This cannot be undone.`;
    }

    await client.releaseDatabase(id);
    return `✅ Database ${id} released.`;
  },
};
