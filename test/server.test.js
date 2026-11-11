import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(b);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(a);
  return client;
}

test("exposes the CRM, Cliq, WorkDrive and DB tools", async () => {
  const { tools } = await (await connect()).listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "cliq_get_messages", "cliq_list_channel_members", "cliq_list_channels",
    "crm_get_record", "crm_list_modules", "crm_list_records", "crm_search_records",
    "db_count", "db_list_tables", "db_query",
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
