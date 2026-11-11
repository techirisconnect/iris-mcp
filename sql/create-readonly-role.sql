-- Read-only Postgres role for iris-mcp. Run once in the Supabase SQL Editor.
-- 1) Replace PUT_A_LONG_RANDOM_PASSWORD (use only letters and digits to keep the connection string simple).
-- 2) Adjust the table list and the excluded columns below to taste.

create role iris_mcp_ro login password 'PUT_A_LONG_RANDOM_PASSWORD';

-- Belt and braces: even if a write were attempted, the session rejects it.
alter role iris_mcp_ro set default_transaction_read_only = on;
alter role iris_mcp_ro set statement_timeout = '10s';

grant usage on schema public to iris_mcp_ro;

-- The IRIS tables have Row Level Security on, and a role without a policy sees
-- zero rows. BYPASSRLS lets this role read every row; it can still only SELECT
-- the granted columns and cannot write.
alter role iris_mcp_ro bypassrls;

-- Column-level SELECT on the allowed tables, skipping secrets and access codes.
do $$
declare r record;
begin
  for r in
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in (
         'properties', 'rental_managers', 'leases', 'tenants',
         'maintenance_requests', 'property_tenant_waitlist'
       )
       and column_name !~* '(pass|token|secret|hash|api_?key)'
       and column_name not in ('access_code', 'access_instructions', 'insurance_policy_number')
  loop
    execute format('grant select (%I) on public.%I to iris_mcp_ro', r.column_name, r.table_name);
  end loop;
end $$;

-- To revoke everything later:
--   drop owned by iris_mcp_ro; drop role iris_mcp_ro;
