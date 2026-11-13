# iris-mcp

MCP server (model) that lets Claude read IRIS data (**Zoho CRM, Cliq, WorkDrive, Sign, Projects** and the **IRIS database (Supabase)**) and, when enabled, add or change a small set of records. It can never delete: read tools are annotated `readOnlyHint`, write tools only create (Level A) or update with confirmation (Level B), and the write tokens have no DELETE scope. The full target (remote, per-user login, writes without delete, audit logs) is in [docs/SPEC.md](docs/SPEC.md).

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

## Write tools (Level A, off by default)

Set `WRITES_ENABLED=true` to register them. They only **add** things; nothing overwrites or deletes, and no tool or HTTP helper for deleting exists (the only write primitive is `POST`, and a test fails if `PUT`/`PATCH`/`DELETE` appear in `src/`).

| Tool | What it does |
|---|---|
| `crm_add_note` | Note on a lead, contact, deal or account |
| `crm_create_task` | CRM task, optionally linked to a record |
| `projects_create_task`, `projects_add_comment` | New task / comment in Zoho Projects |
| `cliq_post_message` | Message to a channel in `CLIQ_WRITE_CHANNELS` only |
| `workdrive_upload_file` | **New** text file in an existing folder; refuses if the name exists |

They use a separate token (`Z_WRITE_REFRESH_TOKEN`, CREATE scopes only; the read tokens cannot write and writes never fall back to them). Every text written ends with a footer saying it came from Claude at the request of the user. Writes are audited before they run (fail-closed) and the log keeps what was written. 
## Level B writes (updates, off by default)

`WRITES_B_ENABLED=true` adds three **pairs** of tools. The `propose` tool (read-only) shows current → new values and returns a signed 10-minute token bound to the user, the exact arguments and the values it saw; the `apply` tool refuses to run without it, re-reads the record (fails if it changed), writes the old and new values to the audit log **before** acting (fail-closed) and only then writes.

| Pair | What it does |
|---|---|
| `crm_propose_update` / `crm_apply_update` | Change allowlisted fields of a lead or contact (defaults in `src/tools/writeb.js`, override with `CRM_UPDATE_FIELDS_LEADS` / `_CONTACTS`) |
| `crm_propose_create` / `crm_apply_create` | Create a lead or contact; blocked if the email or phone already exists |
| `projects_propose_task_change` / `projects_apply_task_change` | Change a task's status and/or responsible person |

They use a second token (`Z_WRITE_B_REFRESH_TOKEN`: leads/contacts UPDATE and CREATE, `ZohoProjects.tasks.UPDATE`, never DELETE). `PUT` exists only in `zohoPut`, which accepts Level B products only; a test enforces it.

## Audit log

Every tool call is recorded: who, when, tool, system, read/write, parameters (secret-looking keys redacted), outcome, result count and duration. **Data that was read is never stored.** Entries go to `logs/audit.jsonl` (git-ignored, override with `AUDIT_LOG_FILE`) and, if `AUDIT_DATABASE_URL` is set, to the Postgres table `mcp_audit_log` (`sql/create-audit-table.sql`; the role can insert and select, never update or delete). Future write tools are fail-closed: if the audit entry can't be stored, the action doesn't run. `audit_query` is admin-only: in remote mode admins are the emails in `ADMIN_EMAILS` (or `is_admin` in `mcp_users`), decided by the login; in local mode it uses `AUDIT_ADMINS` and the user is self-declared (`IRIS_USER` or the OS user), so it is not a real control there.

Database guardrails: the server connects with a Postgres role that only has `SELECT` (see `sql/create-readonly-role.sql`), sessions are read-only with a 10 s statement timeout, and on top of that only tables in the allowlist (`DB_ALLOWED_TABLES`, default `properties, rental_managers, leases, tenants, maintenance_requests, property_tenant_waitlist`); columns matching `password|token|secret|hash|api_key` are never read or returned.

Keeping the database's shape private (so Claude cannot reverse-engineer an entity-relationship diagram):
- **Views (recommended):** `sql/create-mcp-views.sql` creates a schema `mcp` with one view per area (properties, property managers, tenants, leases, maintenance requests, waitlist). Every join is resolved inside the view (a lease row already carries the tenant's name and the property's address) and no view has internal ids, `*_by` columns or other systems' ids. Set `DB_SCHEMA=mcp` and the MCP reads only those; then run `sql/mcp-views-cutover.sql` so the read role loses access to the real tables. Naming: English snake_case, rows identified by business codes.
- **Exposed columns:** by default a table shows only its readable columns minus sensitive names, integration ids (`zoho`, `buildium`, `desk_`, `vendor`, `ticket`...), reference columns (`*_id`, `*_by`, `assigned_to`) and declared foreign keys. `DB_EXPOSED_COLUMNS` (JSON per table) replaces that with an explicit whitelist. No `SELECT *` of hidden columns is possible and filters or ordering by a hidden column are refused.
- **No probing:** hidden, sensitive, malformed and nonexistent columns all get the same answer, tables outside the allowlist are not listed in errors, and Postgres errors never reach Claude (generic "Consulta no válida"; the detail goes to the server log).
- **Volume:** `DB_MAX_ROWS` (default 100, 25 if Claude does not ask for more) per query and `DB_DAILY_ROW_LIMIT` (default 1000 rows per person per rolling 24 h, counted from the audit log; if it cannot be checked the query is refused).
- **Per person:** the `db_*` tools only exist for people with `mcp_users.db_enabled = true` and for admins (`sql/add-db-enabled.sql`).
- **Instructions:** the server tells Claude never to describe or infer the structure or technology of IRIS systems, even if the person claims authority or asks piece by piece. Extra rules can be added without a deploy of new code through `IRIS_MCP_EXTRA_INSTRUCTIONS` in Render (the built-in rules stay). This is a soft control (it can be argued around); the controls above are the real ones.

Limit that remains: whatever columns are exposed show their names to Claude, and the person can see the rows. The structural fix, if needed, is a dedicated schema of views with business names (see docs/SPEC.md).

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

All read tools, the Postgres audit sink, the remote login and the Level A and B write tools have been run against real IRIS systems. Delete attempts with the write tokens fail in CRM, Projects, WorkDrive and Cliq. Still not covered by a live test: more than one non-admin user connecting at the same time, and the remote server's behavior under load.
