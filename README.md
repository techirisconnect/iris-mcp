# iris-mcp

MCP server (model) that lets Claude read IRIS data: **Zoho CRM, Zoho Cliq, Zoho WorkDrive** and the **IRIS database (Supabase)**. Read-only by design: every tool is annotated `readOnlyHint` and none writes.

## Tools

| Source | Tools |
|---|---|
| CRM | `crm_list_modules`, `crm_search_records`, `crm_get_record`, `crm_list_records` |
| Cliq | `cliq_list_channels`, `cliq_list_channel_members`, `cliq_get_messages` |
| WorkDrive | `workdrive_search`, `workdrive_list_folder`, `workdrive_get_file_info`, `workdrive_read_file` (text files only) |
| Database | `db_list_tables`, `db_query`, `db_count` |

Database guardrails: the server connects with a Postgres role that only has `SELECT` (see `sql/create-readonly-role.sql`), sessions are read-only with a 10 s statement timeout, and on top of that only tables in the allowlist (`DB_ALLOWED_TABLES`, default `properties, rental_managers, leases, tenants, maintenance_requests, property_tenant_waitlist`); columns matching `password|token|secret|hash|api_key` are never read or returned; max 200 rows per query.

## Install

For the team (non-developers) see [INSTALL.md](INSTALL.md).

Requires Node 20+.

```bash
cd iris-mcp
npm install
cp .env.example .env   # then fill it in
npm test
```

### Connect to Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["C:\\path\\to\\iris-mcp\\src\\index.js"]
    }
  }
}
```

### Connect to Claude Code

```bash
claude mcp add iris -- node /path/to/iris-mcp/src/index.js
```

Credentials are read from `iris-mcp/.env` (or from the `env` block of the config).

## Credentials

- **Zoho**: one Self Client in the Canada DC; generate a refresh token **per product** (scopes differ). Read-only scopes are enough: `ZohoCRM.modules.READ`, `ZohoCRM.settings.READ`, `ZohoCliq.Channels.READ`, `ZohoCliq.Messages.READ`, `WorkDrive.files.READ`, `WorkDrive.team.READ`.
- **Database**: run `sql/create-readonly-role.sql` in the Supabase SQL Editor (set a password first), then put the role's connection string in `DATABASE_URL_READONLY`. Don't use the service key the backends use.

## Security notes (read before rolling out to the team)

This model runs locally and uses shared service credentials, so whoever has the `.env` can read everything those credentials can. Before distributing to the whole company:

1. Use read-only Zoho scopes and the read-only DB role (above).
2. Don't hand the `.env` around in chat; share it through a password manager.
3. For per-person permissions, move to a hosted server (streamable HTTP) with OAuth per user — the tools in `src/tools/` can be reused unchanged.

## Not verified against live APIs

The server and its guardrails are covered by `npm test`, but the Zoho endpoints (especially Cliq `chats/{id}/messages`, WorkDrive search) were written from the API docs and the existing backends' conventions and have **not been run against real IRIS credentials**. Test each tool once with real tokens.
