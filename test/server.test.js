import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";

delete process.env.WRITES_B_ENABLED;
delete process.env.WRITES_ENABLED; // a developer's local .env may enable writes; these tests assume read-only

// Keep test runs out of the real audit log.
const memorySink = (rows = []) => ({
  name: "memory", rows,
  write: async (e) => { rows.push(e); },
  query: async () => rows.slice().reverse(),
});

async function connect(opts = { sinks: [memorySink()], user: "tester" }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(opts).connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  return client;
}

test("exposes the CRM, Cliq, WorkDrive, DB, Sign and Projects tools", async () => {
  const { tools } = await (await connect()).listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "audit_query",
    "cliq_get_messages", "cliq_list_channel_members", "cliq_list_channels",
    "crm_get_record", "crm_list_modules", "crm_list_records", "crm_search_records",
    "db_count", "db_list_tables", "db_query",
    "projects_get_task", "projects_list_projects", "projects_list_tasks",
    "sign_get_request", "sign_list_requests",
    "workdrive_get_file_info", "workdrive_list_folder", "workdrive_read_file", "workdrive_search",
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
});

test("db_query rejects tables outside the allowlist", async () => {
  const r = await (await connect()).callTool({ name: "db_query", arguments: { table: "users" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no permitida/);
});

test("db_query rejects sensitive columns", async () => {
  const r = await (await connect()).callTool({
    name: "db_query", arguments: { table: "tenants", columns: ["password_hash"] },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /sensible/);
});

test("zoho tools fail cleanly when not configured", async () => {
  for (const k of ["Z_CLIENT_ID", "Z_CLIENT_SECRET", "Z_REFRESH_TOKEN"]) delete process.env[k];
  const r = await (await connect()).callTool({
    name: "crm_search_records", arguments: { module: "Leads", word: "xx" },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no configurado/);
});

test("crm module names cannot inject path segments", async () => {
  const r = await (await connect()).callTool({
    name: "crm_get_record", arguments: { module: "../x", id: "1" },
  });
  assert.equal(r.isError, true);
});

test("buildSelect parameterizes values and quotes identifiers", async () => {
  const { buildSelect } = await import("../src/tools/db.js");
  const { text, values } = buildSelect({
    table: "properties", columns: ["id", "city"],
    filters: [
      { column: "city", op: "ilike", value: "vic%'; drop table x;--" },
      { column: "id", op: "in", value: ["a", "b"] },
      { column: "furnished", op: "is", value: null },
    ],
    order_by: "created_at", ascending: false, limit: 10,
  });
  assert.equal(
    text,
    'SELECT "id", "city" FROM public."properties" WHERE "city" ILIKE $1 AND "id" = ANY($2) AND "furnished" IS NULL ORDER BY "created_at" DESC LIMIT 10',
  );
  assert.deepEqual(values, ["vic%'; drop table x;--", ["a", "b"]]);
});

test("db tools fail cleanly without DATABASE_URL_READONLY", async () => {
  delete process.env.DATABASE_URL_READONLY;
  const r = await (await connect()).callTool({ name: "db_count", arguments: { table: "properties" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /DATABASE_URL_READONLY/);
});

// --- Sign and Projects, with fetch mocked (no network) ---

async function withMockedZoho(routes, fn) {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, {
    Z_CLIENT_ID: "id", Z_CLIENT_SECRET: "secret", Z_REFRESH_TOKEN: "rt", PROJECTS_PORTAL_ID: "p1",
  });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/oauth/v2/token")) return Response.json({ access_token: "at", expires_in: 3600 });
    const hit = routes.find(([match]) => u.includes(match));
    if (!hit) return new Response("not mocked", { status: 500 });
    return Response.json(hit[1]);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
}

test("sign_list_requests filters by status in Node and slims the output", async () => {
  const rows = [
    { request_id: "1", request_name: "Lease_Jane - 1 Main St", request_status: "inprogress", created_time: 1760000000000, actions: [{ recipient_name: "Jane", recipient_email: "j@x.com", action_type: "SIGN", action_status: "UNOPENED" }] },
    { request_id: "2", request_name: "Lease_Bob - 2 Oak St", request_status: "completed", created_time: 1750000000000, actions: [] },
  ];
  await withMockedZoho([["/requests", { status: "success", requests: rows, page_context: { has_more_rows: false } }]], async () => {
    const r = await (await connect()).callTool({ name: "sign_list_requests", arguments: { status: "InProgress" } });
    assert.equal(r.isError, undefined);
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.count, 1);
    assert.equal(out.requests[0].request_id, "1");
    assert.equal(out.requests[0].signers[0].status, "UNOPENED");
  });
});

test("projects tools use index starting at 1 and slim tasks", async () => {
  const task = { id_string: "t1", name: "Fix sink", status: { name: "Open" }, priority: "High", description: "<p>Leaking</p>", details: { owners: [{ name: "Ann" }] }, link: { web: { url: "https://z/t1" } } };
  await withMockedZoho([["/tasks/", { tasks: [task] }]], async (calls) => {
    const r = await (await connect()).callTool({ name: "projects_list_tasks", arguments: { project_id: "9" } });
    const out = JSON.parse(r.content[0].text);
    assert.equal(out.tasks[0].description, "Leaking");
    assert.deepEqual(out.tasks[0].owners, ["Ann"]);
    const url = new URL(calls.find((c) => c.includes("/tasks/")));
    assert.equal(url.searchParams.get("index"), "1");
    assert.equal(url.searchParams.get("status"), "notcompleted");
    assert.match(url.pathname, /\/restapi\/portal\/p1\/projects\/9\/tasks\//);
  });
});

test("projects tools fail cleanly without PROJECTS_PORTAL_ID", async () => {
  const saved = process.env.PROJECTS_PORTAL_ID;
  delete process.env.PROJECTS_PORTAL_ID;
  const r = await (await connect()).callTool({ name: "projects_list_projects", arguments: {} });
  if (saved) process.env.PROJECTS_PORTAL_ID = saved;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /PROJECTS_PORTAL_ID/);
});

// --- Audit log ---

test("audit logs every call with user, params and result count but not the data", async () => {
  const sink = memorySink();
  const client = await connect({ sinks: [sink], user: "ana@iris.ca" });
  await client.callTool({ name: "db_count", arguments: { table: "users" } }); // rejected by allowlist
  const rows = sink.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, "ana@iris.ca");
  assert.equal(rows[0].tool, "db_count");
  assert.equal(rows[0].system, "db");
  assert.equal(rows[0].kind, "read");
  assert.equal(rows[0].outcome, "error");
  assert.equal(rows[0].params.table, "users");
  assert.ok(rows[0].duration_ms >= 0);
});

test("audit logs successful reads with a result count and no payload", async () => {
  const sink = memorySink();
  const rowsData = [
    { request_id: "1", request_name: "Lease_A", request_status: "completed", created_time: 1760000000000, actions: [] },
    { request_id: "2", request_name: "Lease_B", request_status: "completed", created_time: 1750000000000, actions: [] },
  ];
  await withMockedZoho([["/requests", { status: "success", requests: rowsData, page_context: { has_more_rows: false } }]], async () => {
    const client = await connect({ sinks: [sink], user: "ana@iris.ca" });
    await client.callTool({ name: "sign_list_requests", arguments: {} });
  });
  assert.equal(sink.rows[0].outcome, "ok");
  assert.equal(sink.rows[0].result_count, 2);
  assert.ok(!JSON.stringify(sink.rows[0]).includes("Lease_A"));
});

test("audit redacts secret-looking params", async () => {
  const { redact } = await import("../src/audit.js");
  assert.deepEqual(redact({ api_key: "x", note: "hi", nested: { Password: "p" } }), {
    api_key: "[redacted]", note: "hi", nested: { Password: "[redacted]" },
  });
});

test("audit_query is admin-only", async () => {
  process.env.AUDIT_ADMINS = "boss@iris.ca";
  try {
    const denied = await (await connect({ sinks: [memorySink()], user: "ana@iris.ca" })).callTool({ name: "audit_query", arguments: {} });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /administradores/);
    const allowed = await (await connect({ sinks: [memorySink()], user: "boss@iris.ca" })).callTool({ name: "audit_query", arguments: {} });
    assert.equal(allowed.isError, undefined);
  } finally {
    delete process.env.AUDIT_ADMINS;
  }
});

test("write tools are fail-closed when the audit log cannot be written", async () => {
  const { auditServer } = await import("../src/audit.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "t", version: "0" });
  auditServer(server, { user: "ana", sinks: [{ name: "broken", write: async () => { throw new Error("disk full"); } }] });
  let ran = false;
  server.registerTool("crm_create_note", { description: "x", inputSchema: {} }, async () => { ran = true; return { content: [{ type: "text", text: "{}" }] }; });
  server.registerTool("crm_read", { description: "x", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "{}" }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  const w = await client.callTool({ name: "crm_create_note", arguments: {} });
  assert.equal(w.isError, true);
  assert.equal(ran, false);
  const r = await client.callTool({ name: "crm_read", arguments: {} });
  assert.equal(r.isError, undefined); // reads keep working
});

test("file sink appends JSON lines and can be queried", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileSink } = await import("../src/audit.js");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "audit-")), "a.jsonl");
  const sink = fileSink(file);
  await sink.write({ ts: "2026-11-11T00:00:00Z", user: "ana", tool: "db_count", outcome: "ok" });
  await sink.write({ ts: "2026-11-11T00:01:00Z", user: "bob", tool: "crm_get_record", outcome: "error" });
  assert.equal((await sink.query({ user: "bob" })).length, 1);
  assert.equal((await sink.query({})).length, 2);
});
