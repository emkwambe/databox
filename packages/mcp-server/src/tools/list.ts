import type { ToolDefinition } from "../types.js";

// Render seconds as a compact human duration (e.g. 1h 05m, 45s).
function formatDuration(seconds: number): string {
  if (seconds <= 0) return "expired";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export const listTool: ToolDefinition = {
  name: "list_databases",
  description: "List all currently active claimed databases for your API key.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  handler: async (client) => {
    const dbs = await client.listDatabases();
    if (dbs.length === 0) return "No active databases.";

    const header = ["DATABASE ID", "PACK", "ROWS", "EXPIRES IN"];
    const rows = dbs.map((d) => [
      d.database_id,
      d.pack,
      String(d.rows_seeded),
      formatDuration(d.ttl_seconds_remaining),
    ]);

    // Compute column widths for a monospaced table.
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );
    const line = (cells: string[]) =>
      cells.map((c, i) => c.padEnd(widths[i])).join("  ");

    return [
      `${dbs.length} active database${dbs.length === 1 ? "" : "s"}:`,
      "",
      line(header),
      line(widths.map((w) => "-".repeat(w))),
      ...rows.map(line),
    ].join("\n");
  },
};
