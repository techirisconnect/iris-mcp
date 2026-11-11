-- Audit log for iris-mcp. Run in the Supabase SQL Editor.
-- Reads are logged without the data that was read (only params and result count).

create table if not exists public.mcp_audit_log (
  id           bigint generated always as identity primary key,
  ts           timestamptz not null default now(),
  "user"       text        not null,
  tool         text        not null,
  system       text        not null,
  kind         text        not null check (kind in ('read', 'write')),
  phase        text        not null check (phase in ('before', 'after')),
  outcome      text        not null check (outcome in ('ok', 'error', 'attempt')),
  params       jsonb       not null default '{}'::jsonb,
  error        text,
  result_count integer,
  duration_ms  integer
);

create index if not exists mcp_audit_log_ts_idx on public.mcp_audit_log (ts desc);
create index if not exists mcp_audit_log_user_idx on public.mcp_audit_log ("user", ts desc);

-- Role: can append and read, never update or delete (the log is tamper-resistant).
-- Set a strong password first, then use its pooler connection string as AUDIT_DATABASE_URL.
create role iris_mcp_audit login password 'CHANGE_ME';
alter role iris_mcp_audit set default_transaction_read_only = off;

alter table public.mcp_audit_log enable row level security;
create policy mcp_audit_insert on public.mcp_audit_log for insert to iris_mcp_audit with check (true);
create policy mcp_audit_select on public.mcp_audit_log for select to iris_mcp_audit using (true);

revoke all on public.mcp_audit_log from public, anon, authenticated;
grant usage on schema public to iris_mcp_audit;
grant insert, select on public.mcp_audit_log to iris_mcp_audit;
grant usage on sequence public.mcp_audit_log_id_seq to iris_mcp_audit;
-- Explicitly no UPDATE, DELETE or TRUNCATE.
