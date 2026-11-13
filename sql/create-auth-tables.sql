-- Login tables for the remote iris-mcp (OAuth server + user allowlist).
-- Run in the Supabase SQL Editor. Tokens and codes are stored only as SHA-256 hashes.
-- The role can insert, read and update (mark used / revoked) but never delete.

create table if not exists public.mcp_users (
  email         text primary key,            -- lowercase
  name          text,
  is_admin      boolean not null default false,
  db_enabled    boolean not null default false,  -- database tools (db_*) only for people with true; admins always have them
  revoked_at   timestamptz,                 -- set = access cut off immediately
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists public.mcp_oauth_clients (
  client_id  text primary key,
  info       jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_pending (
  txn_hash   text primary key,
  data       jsonb not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_codes (
  code_hash  text primary key,
  data       jsonb not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_tokens (
  token_hash text primary key,
  kind       text not null check (kind in ('access', 'refresh')),
  client_id  text not null,
  email      text not null,
  scopes     text[] not null,
  resource   text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mcp_oauth_tokens_email_idx on public.mcp_oauth_tokens (email);

-- Role used by the server for these tables. Set a strong password first
-- (letters and numbers only, so the connection URL needs no escaping).
create role iris_mcp_auth login password 'CHANGE_ME';
alter role iris_mcp_auth set default_transaction_read_only = off;
grant usage on schema public to iris_mcp_auth;

do $$
declare t text;
begin
  foreach t in array array['mcp_users', 'mcp_oauth_clients', 'mcp_oauth_pending', 'mcp_oauth_codes', 'mcp_oauth_tokens']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update on public.%I to iris_mcp_auth', t);
    execute format('create policy %I on public.%I for select to iris_mcp_auth using (true)', t || '_sel', t);
    execute format('create policy %I on public.%I for insert to iris_mcp_auth with check (true)', t || '_ins', t);
    execute format('create policy %I on public.%I for update to iris_mcp_auth using (true) with check (true)', t || '_upd', t);
  end loop;
end $$;
-- Explicitly no DELETE or TRUNCATE.

-- Managing who has access (run as admin in the SQL Editor):
--   add:     insert into public.mcp_users (email) values ('person@irisproperties.ca');
--   revoke:  update public.mcp_users set revoked_at = now() where email = 'person@irisproperties.ca';
--   restore: update public.mcp_users set revoked_at = null where email = 'person@irisproperties.ca';
-- Revocation takes effect on the person's very next request.
