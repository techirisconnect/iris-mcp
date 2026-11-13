-- Per-person switch for the database tools (db_list_tables, db_query, db_count).
-- Run in the Supabase SQL Editor BEFORE deploying the code that reads it (old code ignores the column).
-- New and existing people start WITHOUT database access; admins (ADMIN_EMAILS / is_admin) always have it.

alter table public.mcp_users add column if not exists db_enabled boolean not null default false;

-- Enable the people who need tenant, lease and property data:
--   update public.mcp_users set db_enabled = true where email in ('persona@irisproperties.ca');
-- Take it away again (effective on their next call):
--   update public.mcp_users set db_enabled = false where email = 'persona@irisproperties.ca';
-- See who has it:
--   select email, is_admin, db_enabled, revoked_at from public.mcp_users order by email;
