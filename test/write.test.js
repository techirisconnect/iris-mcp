import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { resetTokenCache } from "../src/zoho.js";

const WRITE_TOOLS = [
  "cliq_post_message", "crm_add_note", "crm_create_task",
  "projects_add_comment", "projects_create_task", "workdrive_upload_file",
];

/** Run fn with env + mocked fetch; routes are [urlPart, response|fn]. Records every request. */
async function withEnv(extraEnv, routes, fn) {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  resetTokenCache();
  delete process.env.WRITES_B_ENABLED; // a local .env may enable Level B; these tests cover Level A only
  Object.assign(process.env, {
    Z_CLIENT_ID: "id", Z_CLIENT_SECRET: "secret", Z_REFRESH_TOKEN: "READ-token", Z_WRITE_REFRESH_TOKEN: "WRITE-token",
    PROJECTS_PORTAL_ID: "p1", WRITES_ENABLED: "true", CLIQ_WRITE_CHANNELS: "tech-team", ...extraEnv,
  });
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete process.env[k];
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    requests.push({ url: u, method: init.method || "GET", body: init.body, headers: init.headers });
    if (u.includes("/oauth/v2/token")) return Response.json({ access_token: `at-${init.body.get("refresh_token")}`, expires_in: 3600 });
    const hit = routes.find(([m]) => u.includes(m));
    if (!hit) return new Response("not mocked", { status: 500 });
    return typeof hit[1] === "function" ? hit[1](u, init) : Response.json(hit[1]);
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
}

async function connect() {
  const rows = [];
  const sink = { name: "memory", write: async (e) => { rows.push(e); }, query: async () => rows };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ user: "ana@iris.ca", sinks: [sink] }).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return { client, rows };
}

const posts = (requests) => requests.filter((r) => r.method !== "GET" && !r.url.includes("/oauth/"));

test("write tools do not exist unless WRITES_ENABLED=true", async () => {
  await withEnv({ WRITES_ENABLED: undefined }, [], async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) assert.ok(!names.includes(w), `${w} should not be registered`);
  });
});

test("write tools are exactly the Level A list, none can delete", async () => {
  await withEnv({}, [], async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const writes = tools.filter((t) => !t.annotations?.readOnlyHint && t.name !== "audit_query");
    assert.deepEqual(writes.map((t) => t.name).sort(), WRITE_TOOLS);
    for (const t of tools) assert.doesNotMatch(t.name, /delete|remove|trash|destroy|purge|archive/i);
    for (const t of writes) assert.equal(t.annotations.destructiveHint, false);
  });
});

test("source never uses DELETE/PATCH, and PUT only in zoho.js for Level B", () => {
  const dir = path.resolve("src");
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(text, /["'`](DELETE|PATCH)["'`]/, `${f} uses a forbidden HTTP method`);
    if (f !== "zoho.js") assert.doesNotMatch(text, /["'`]PUT["'`]/, `${f} uses PUT outside zoho.js`);
  }
  const zoho = fs.readFileSync(path.join(dir, "zoho.js"), "utf8");
  assert.match(zoho, /zohoPut[\s\S]*endsWith\("_b"\)/); // PUT is restricted to Level B products
});

test("crm_add_note POSTs with the WRITE token, signs the text and is audited as a write", async () => {
  await withEnv({}, [["/crm/v2/Notes",{ data: [{ code: "SUCCESS", details: { id: "n1" } }] }]], async (requests) => {
    const { client, rows } = await connect();
    const r = await client.callTool({ name: "crm_add_note", arguments: { module: "Leads", id: "123", content: "Llamó, quiere ver el unit" } });
    assert.equal(r.isError, undefined);
    assert.equal(JSON.parse(r.content[0].text).id, "n1");
    const [p] = posts(requests);
    assert.equal(p.method, "POST");
    assert.match(p.url, /\/crm\/v2\/Notes$/);
    assert.deepEqual([JSON.parse(p.body).data[0].Parent_Id, JSON.parse(p.body).data[0].se_module], ["123", "Leads"]);
    assert.match(p.body, /a pedido de ana@iris\.ca/);
    assert.match(p.headers.Authorization, /at-WRITE-token/); // never the read token
    const tokenCalls = requests.filter((q) => q.url.includes("/oauth/"));
    assert.ok(tokenCalls.every((q) => q.body.get("refresh_token") === "WRITE-token"));
    assert.deepEqual(rows.map((x) => [x.kind, x.phase, x.outcome]), [["write", "before", "attempt"], ["write", "after", "ok"]]);
    assert.match(rows[0].params.content, /quiere ver el unit/); // what was written is in the log
  });
});

test("writes never fall back to the read token", async () => {
  await withEnv({ Z_WRITE_REFRESH_TOKEN: undefined }, [], async (requests) => {
    const { client } = await connect();
    const r = await client.callTool({ name: "crm_add_note", arguments: { module: "Leads", id: "1", content: "x" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Z_WRITE_REFRESH_TOKEN/);
    assert.equal(posts(requests).length, 0);
  });
});

test("crm write failures reported by Zoho are surfaced, not hidden as success", async () => {
  await withEnv({}, [["/Notes", { data: [{ code: "INVALID_DATA", message: "bad id" }] }]], async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "crm_add_note", arguments: { module: "Leads", id: "1", content: "x" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /bad id/);
  });
});

test("crm_create_task links contacts with Who_Id and others with What_Id", async () => {
  await withEnv({}, [["/crm/v2/Tasks", { data: [{ code: "SUCCESS", details: { id: "t1" } }] }]], async (requests) => {
    const { client } = await connect();
    await client.callTool({ name: "crm_create_task", arguments: { subject: "Call back", due_date: "2026-11-20", related_module: "Contacts", related_id: "5" } });
    await client.callTool({ name: "crm_create_task", arguments: { subject: "Follow up", related_module: "Deals", related_id: "6" } });
    const [a, b] = posts(requests).map((p) => JSON.parse(p.body).data[0]);
    assert.deepEqual(a.Who_Id, { id: "5" });
    assert.equal(a.Due_Date, "2026-11-20");
    assert.deepEqual(b.What_Id, { id: "6" });
    assert.equal(b.$se_module, "Deals");
    const bad = await client.callTool({ name: "crm_create_task", arguments: { subject: "x", related_module: "Deals" } });
    assert.equal(bad.isError, true);
  });
});

test("projects tools use the legacy form API with MM-DD-YYYY dates", async () => {
  await withEnv({}, [
    ["/tasks/9/comments/", { comments: [{}] }],
    ["/projects/7/tasks/", { tasks: [{ id_string: "t9", link: { web: { url: "https://z/t9" } } }] }],
  ], async (requests) => {
    const { client } = await connect();
    const c = await client.callTool({ name: "projects_create_task", arguments: { project_id: "7", name: "Fix door", due_date: "2026-11-20" } });
    assert.equal(JSON.parse(c.content[0].text).id, "t9");
    await client.callTool({ name: "projects_add_comment", arguments: { project_id: "7", task_id: "9", content: "Done" } });
    const [create, comment] = posts(requests);
    assert.equal(create.body.get("end_date"), "11-20-2026");
    assert.equal(create.body.get("name"), "Fix door");
    assert.match(comment.body.get("content"), /^Done\n\n— enviado desde Claude/);
    assert.match(comment.url, /\/restapi\/portal\/p1\/projects\/7\/tasks\/9\/comments\/$/);
  });
});

test("cliq_post_message only posts to allowed channels", async () => {
  await withEnv({}, [["/channelsbyname/tech-team/message", () => new Response(null, { status: 204 })]], async (requests) => {
    const { client } = await connect();
    const denied = await client.callTool({ name: "cliq_post_message", arguments: { channel: "general", text: "hola" } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /no permitido/i);
    assert.equal(posts(requests).length, 0);
    const ok = await client.callTool({ name: "cliq_post_message", arguments: { channel: "Tech-Team", text: "hola" } });
    assert.equal(ok.isError, undefined);
    assert.equal(JSON.parse(posts(requests)[0].body).text.startsWith("hola"), true);
  });
  await withEnv({ CLIQ_WRITE_CHANNELS: "" }, [], async () => {
    const { client } = await connect();
    const none = await client.callTool({ name: "cliq_post_message", arguments: { channel: "tech-team", text: "hola" } });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /CLIQ_WRITE_CHANNELS/);
  });
});

test("workdrive_upload_file never overwrites and only takes text files", async () => {
  const listing = { data: [{ id: "f1", attributes: { name: "Notes.txt" } }] };
  await withEnv({}, [
    ["/files/folder1/files", listing],
    ["/workdrive/api/v1/upload", { data: [{ attributes: { resource_id: "new1", FileName: "Report.txt" } }] }],
  ], async (requests) => {
    const { client } = await connect();
    const dup = await client.callTool({ name: "workdrive_upload_file", arguments: { folder_id: "folder1", filename: "notes.TXT", content: "x" } });
    assert.equal(dup.isError, true);
    assert.match(dup.content[0].text, /no se sobrescribe/);
    const pdf = await client.callTool({ name: "workdrive_upload_file", arguments: { folder_id: "folder1", filename: "a.exe", content: "x" } });
    assert.equal(pdf.isError, true);
    assert.equal(posts(requests).length, 0);
    const ok = await client.callTool({ name: "workdrive_upload_file", arguments: { folder_id: "folder1", filename: "Report.txt", content: "hello" } });
    assert.equal(ok.isError, undefined);
    const [p] = posts(requests);
    assert.equal(p.body.get("override-name-exist"), "false");
    assert.equal(p.body.get("parent_id"), "folder1");
  });
});

test("a write is not executed when the audit log cannot be written (fail-closed)", async () => {
  await withEnv({}, [["/Notes", { data: [{ code: "SUCCESS", details: { id: "n" } }] }]], async (requests) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const broken = { name: "broken", write: async () => { throw new Error("disk full"); } };
    await createServer({ user: "ana", sinks: [broken] }).connect(b);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(a);
    const r = await client.callTool({ name: "crm_add_note", arguments: { module: "Leads", id: "1", content: "x" } });
    assert.equal(r.isError, true);
    assert.equal(posts(requests).length, 0);
  });
});
