-- Views the MCP reads instead of the real tables (schema "mcp"). Run in the Supabase SQL Editor.
--
-- Why: Claude should see the data, not the shape of the database. Every join is resolved inside the
-- view, so a row already carries the tenant's name, the property's address, the manager's name...
-- and no view exposes internal ids, "created by" ids, foreign keys or other systems' ids (Zoho,
-- Buildium, Desk, vendors). Rows are identified by business codes (property, lease and tenant codes).
--
-- Naming convention: English snake_case; no *_id / *_by / *_uuid; plain business words.
--
-- Views run with their owner's rights, so iris_mcp_ro only needs SELECT on these views, never on the
-- real tables (see sql/mcp-views-cutover.sql). Run this whole file at once: it is one transaction.
--
-- Assumptions to check (the file fails cleanly if one is wrong, nothing is created):
--   public.users(id, name, email, phone) is the profile behind tenants.user_id
--   leases.tenant_id -> tenants.id, leases.property_id -> properties.id
--   properties.manager_id -> rental_managers.id, properties.current_tenant_id -> tenants.id
--   maintenance_requests.property_id holds either the property's uuid or its business code (both are tried)
-- Left out on purpose (add them back if the team needs them): property images, onboarding_data,
-- tenant avatar fields, Desk/Zoho/Buildium fields, unit and assignee ids, and the three columns
-- access_code, access_instructions and insurance_policy_number that the read role never had.

begin;

create schema if not exists mcp;
revoke all on schema mcp from public, anon, authenticated;

-- ── Properties ───────────────────────────────────────────────────────────────
create or replace view mcp.properties as
select
  p.property_id            as code,
  p.name,
  p.address_line1          as address_line_1,
  p.address_line2          as address_line_2,
  p.street_number, p.street_name, p.street_type, p.unit_number, p.floor_number,
  p.city, p.state, p.postal_code, p.country, p.latitude, p.longitude,
  p.is_active, p.listing_status, p.management_status, p.rented_at, p.available_date, p.available_immediately,
  p.property_type, p.rental_type, p.rental_subtype, p.year_built, p.bedrooms, p.bathrooms, p.size_sqft,
  p.rent_amount, p.security_deposit, p.minimum_lease_term,
  p.furnished, p.furnished_status, p.air_conditioning, p.heating_type, p.flooring_type,
  p.internet_included, p.cable_tv_included, p.included_utilities,
  p.parking_available, p.parking_number, p.storage_available, p.storage_number,
  p.in_unit_laundry, p.elevator_in_building, p.building_gym, p.building_pool, p.building_lounge,
  p.pet_policy, p.smoking_policy, p.features, p.description, p.special_instructions,
  p.trash_location, p.trash_pickup_days, p.strata_management, p.insurance_expiry_date,
  p.owner_name, p.owner_email, p.owner_phone,
  coalesce(nullif(btrim(concat_ws(' ', rm.first_name, rm.last_name)), ''), p.property_manager) as manager_name,
  rm.email                 as manager_email,
  p.manager_contact,
  ct.name                  as current_tenant_name,
  ct.email                 as current_tenant_email,
  ct.phone                 as current_tenant_phone,
  p.source, p.nurturing, p.nurturing_notified_at, p.onboarding_completed_at, p.internal_notes,
  p.created_at, p.updated_at
from public.properties p
left join public.rental_managers rm on rm.id = p.manager_id
left join lateral (
  select u.name, u.email, u.phone
    from public.tenants t
    join public.users u on u.id = t.user_id
   where t.id = p.current_tenant_id
) ct on true;

-- ── Property managers ────────────────────────────────────────────────────────
create or replace view mcp.property_managers as
select
  rm.first_name, rm.last_name, rm.email, rm.phone_numbers, rm.created_at
from public.rental_managers rm;

-- ── Tenants ──────────────────────────────────────────────────────────────────
create or replace view mcp.tenants as
select
  t.tenant_code            as code,
  u.name,
  u.email,
  u.phone,
  t.current_status         as status,
  t.cash_back_balance,
  cp.code                  as current_property_code,
  cp.name                  as current_property_name,
  cp.address               as current_property_address,
  t.created_at, t.updated_at
from public.tenants t
left join public.users u on u.id = t.user_id
left join lateral (
  select p.property_id as code, p.name, concat_ws(', ', p.address_line1, p.city) as address
    from public.properties p
   where p.current_tenant_id = t.id
   order by p.updated_at desc nulls last
   limit 1
) cp on true;

-- ── Leases ───────────────────────────────────────────────────────────────────
create or replace view mcp.leases as
select
  l.lease_code             as code,
  l.status,
  l.start_date, l.end_date, l.renewal_date, l.notice_deadline, l.month_to_month, l.terminated_at,
  l.rent_amount, l.security_deposit_amount, l.pet_deposit_amount,
  l.garbage_day, l.parking_stall,
  t.tenant_code            as tenant_code,
  u.name                   as tenant_name,
  u.email                  as tenant_email,
  u.phone                  as tenant_phone,
  p.property_id            as property_code,
  p.name                   as property_name,
  concat_ws(', ', p.address_line1, p.city) as property_address,
  l.created_at
from public.leases l
left join public.tenants t    on t.id = l.tenant_id
left join public.users u      on u.id = t.user_id
left join public.properties p on p.id = l.property_id;

-- ── Maintenance requests ─────────────────────────────────────────────────────
create or replace view mcp.maintenance_requests as
select
  m.subject, m.description, m.category, m.issue_type, m.priority, m.status, m.resolution,
  m.requester_type, m.requester_name, m.requester_email, m.requester_phone,
  m.assignee_name,
  m.vendor_name            as contractor_name,
  m.vendor_phone           as contractor_phone,
  m.vendor_email           as contractor_email,
  m.estimated_cost, m.actual_cost, m.created_by_staff,
  p.property_id            as property_code,
  p.name                   as property_name,
  coalesce(m.property_address, concat_ws(', ', p.address_line1, p.city)) as property_address,
  m.created_at, m.updated_at, m.resolved_at
from public.maintenance_requests m
left join public.properties p
  on p.id::text = m.property_id::text or p.property_id::text = m.property_id::text;

-- ── Waitlist ─────────────────────────────────────────────────────────────────
create or replace view mcp.waitlist_candidates as
select
  w.full_name, w.email, w.phone, w.status, w.position as queue_position,
  w.expected_move_in, w.expected_lease_end, w.rent_amount, w.security_deposit, w.pet_deposit, w.notes,
  w.portal_invite_sent_at, w.portal_invite_confirmed_at, w.portal_invite_deposit,
  p.property_id            as property_code,
  p.name                   as property_name,
  concat_ws(', ', p.address_line1, p.city) as property_address,
  w.created_by_name        as added_by_name,
  w.created_by_email       as added_by_email,
  w.created_at, w.updated_at
from public.property_tenant_waitlist w
left join public.properties p on p.id = w.property_id;

-- ── Access for the MCP role ──────────────────────────────────────────────────
grant usage on schema mcp to iris_mcp_ro;
grant select on
  mcp.properties, mcp.property_managers, mcp.tenants, mcp.leases,
  mcp.maintenance_requests, mcp.waitlist_candidates
to iris_mcp_ro;

commit;

-- Check (should list the six views, each with the columns above and no *_id / *_by column):
--   select table_name, string_agg(column_name, ', ' order by ordinal_position)
--     from information_schema.columns where table_schema = 'mcp' group by table_name;
-- Never expose the schema through the Supabase API: leave "mcp" out of Settings > API > Exposed schemas.
