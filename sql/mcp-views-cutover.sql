-- Cutover: the MCP role stops reading the real tables and keeps only the "mcp" views.
-- Run ONLY after sql/create-mcp-views.sql worked and the MCP runs with DB_SCHEMA=mcp (checked in Claude).
-- Rolling back: re-run the column grants of sql/create-readonly-role.sql and set DB_SCHEMA back to public.

begin;

-- Table-level and column-level SELECT on everything in public.
revoke all on all tables in schema public from iris_mcp_ro;
do $$
declare r record;
begin
  for r in
    select table_name, column_name
      from information_schema.column_privileges
     where grantee = 'iris_mcp_ro' and table_schema = 'public' and privilege_type = 'SELECT'
  loop
    execute format('revoke select (%I) on public.%I from iris_mcp_ro', r.column_name, r.table_name);
  end loop;
end $$;
revoke usage on schema public from iris_mcp_ro;

commit;

-- Verify: both queries must return no rows.
--   select table_name, column_name from information_schema.column_privileges
--    where grantee = 'iris_mcp_ro' and table_schema = 'public';
--   select table_schema, table_name from information_schema.role_table_grants
--    where grantee = 'iris_mcp_ro' and table_schema <> 'mcp';
