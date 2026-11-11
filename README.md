# iris-mcp

MCP server (model) that lets Claude read IRIS data: **Zoho CRM, Cliq, WorkDrive, Sign, Projects** and the **IRIS database (Supabase)**. Read-only by design (v0.2): every tool is annotated `readOnlyHint` and none writes. The full target (remote, per-user login, writes without delete, audit logs) is in [docs/SPEC.md](docs/SPEC.md).

## Tools

| Source | Tools |
|---|---|
| CRM | `crm_list_modules`, `crm_search_records`, `crm_get_record`, `crm_list_records` |
| Cliq | `cliq_list_channels`, `cliq_list_channel_members`, `cliq_get_messages` |
| WorkDrive | `workdrive_search`, `workdrive_list_folder`, `workdrive_get_file_info`, `workdrive_read_file` (text files only) |
| Database | `db_list_tables`, `db_query`, `db_count` |
| Sign | `sign_list_requests`, `sign_get_request` (status only; sending/recalling is out of scope) |
| Projects | `projects_list_projects`, `projects_list_tasks`, `projects_get_task` |
| Audit | `audit_query` (admins only, see below) |

## Audit log

Every tool call is recorded: who, when, tool, system, read/write, parameters (secret-looking keys redacted), outcome, result count and duration. **Data that was read is never stored.** Entries go to `logs/audit.jsonl` (git-ignored, override with `AUDIT_LOG_FILE`) and, if `AUDIT_DATABASE_URL` is set, to the Postgres table `mcp_audit_log` (`sql/create-audit-table.sql`; the role can insert and select, never update or delete). Future write tools are fail-closed: if the audit entry can't be stored, the action doesn't run. `audit_query` is admin-only: in remote mode admins are the emails in `ADMIN_EMAILS` (or `is_admin` in `mcp_users`), decided by the login; in local mode it uses `AUDIT_ADMINS` and the user is self-declared (`IRIS_USER` or the OS user), so it is not a real control there.

Database guardrails: the server connects with a Postgres role that only has `SELECT` (see `sql/create-readonly-role.sql`), sessions are read-only with a 10 s statement timeout, and on top of that only tables in the allowlist (`DB_ALLOWED_TABLES`, default `properties, rental_managers, leases, tenants, maintenance_requests, property_tenant_waitlist`); columns matching `password|token|secret|hash|api_key` are never read or returned; max 200 rows per query.

## Remote mode (per-person login)

`node src/http.js` serves the same tools over streamable HTTP at `POST /mcp`. The server is its own OAuth authorization server (it supports dynamic client registration, which Zoho does not) and delegates the login to Zoho: Claude → `/authorize` → Zoho login → `/zoho/callback` → our code → `/token`. Only emails present in `mcp_users` (or listed in `ADMIN_EMAILS`) get a token; access tokens last 1 h, refresh tokens 30 days and rotate on use. Tokens are stored hashed, and the user is re-checked on every request, so revoking someone (`update mcp_users set revoked_at = now() ...`) cuts them off on their next call. Every call is audited under their email.

Setup: run `sql/create-auth-tables.sql`, create the Zoho login client, set the variables from `.env.example` (remote section) and deploy with `render.yaml`. Step-by-step in [docs/DEPLOY.md](docs/DEPLOY.md).

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

- **Zoho**: one Self Client in the Canada DC; generate a refresh token **per product** (scopes differ). Read-only scopes are enough: `ZohoCRM.modules.READ`, `ZohoCRM.settings.READ`, `ZohoCliq.Channels.READ`, `ZohoCliq.Messages.READ`, `WorkDrive.files.READ`, `WorkDrive.team.READ`, and for Sign and Projects `ZohoSign.documents.READ`, `ZohoProjects.portals.READ`, `ZohoProjects.projects.READ`, `ZohoProjects.tasks.READ`, `ZohoProjects.tasklists.READ`. Sign and Projects reuse `Z_REFRESH_TOKEN` unless `Z_SIGN_REFRESH_TOKEN` / `PROJECTS_REFRESH_TOKEN` are set; Projects also needs `PROJECTS_PORTAL_ID`.
- **Database**: run `sql/create-readonly-role.sql` in the Supabase SQL Editor (set a password first), then put the role's connection string in `DATABASE_URL_READONLY`. Don't use the service key the backends use.

## Security notes (read before rolling out to the team)

This model runs locally and uses shared service credentials, so whoever has the `.env` can read everything those credentials can. Before distributing to the whole company:

1. Use read-only Zoho scopes and the read-only DB role (above).
2. Don't hand the `.env` around in chat; share it through a password manager.
3. For per-person permissions, move to a hosted server (streamable HTTP) with OAuth per user — the tools in `src/tools/` can be reused unchanged.

## Not verified against live APIs

All read tools (CRM, Cliq, WorkDrive, DB, Sign, Projects) have been run against real IRIS credentials. Still unconfirmed: Projects task comments (returned empty on the one task tried) and the Postgres audit sink (only the file sink and in-memory sinks are covered by tests).
