# @realitydb/mcp-server

MCP server for the RealityDB Claimable Database Agent API.

Provision live PostgreSQL databases pre-seeded with realistic, domain-specific
synthetic data — banking, healthcare, telecom, supply chain, and more — directly
from any MCP-compatible agent (Claude, Cursor, Gemini). Each database has a TTL
and auto-deletes, so it is safe to claim, use, and throw away.

## Installation

```sh
npx @realitydb/mcp-server
```

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "realitydb": {
      "command": "npx",
      "args": ["-y", "@realitydb/mcp-server"],
      "env": {
        "REALITYDB_API_KEY": "rdb_agent_your_key"
      }
    }
  }
}
```

## Available Tools

- **claim_database** — Provision a live PostgreSQL database with synthetic data
- **release_database** — Release a database early (frees quota; irreversible)
- **list_databases** — List your active claimed databases
- **list_packs** — List available domain packs and their compliance coverage
- **check_quota** — Check your current usage and plan limits

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `REALITYDB_API_KEY` | yes | Your agent API key (`rdb_agent_...`). May also be passed as `--api-key <key>`. |
| `REALITYDB_BASE_URL` | no | Override the API base URL (defaults to `https://lab.realitydb.dev`). |

## Get an API Key

Visit [realitydb.dev/agent](https://realitydb.dev/agent).

## License

MIT
