import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/index.js";
import { resetTokenCache } from "../src/zoho.js";

const B_TOOLS = [
  "crm_apply_create", "crm_apply_update", "crm_propose_create", "crm_propose_update",
  "projects_apply_task_change", "projects_propose_task_change",
];

/** Env + mocked fetch. routes: [urlPart, response | (url, init) => Response], first match wins. */
async function withEnv(extraEnv, routes, fn) {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  resetTokenCache();
  Object.assign(process.env, {
    Z_CLIENT_ID: "id", Z_CLIENT_SECRET: "secret", Z_REFRESH_TOKEN: "READ-token", Z_WRITE_B_REFRESH_TOKEN: "B-token",
    PROJECTS_PORTAL_ID: "p1", WRITES_B_ENABLED: "true", CONFIRM_SECRET: "test-secret", ...extraEnv,
  });
  delete process.env.WRITES_ENABLED;
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

async function connect(user = "ana@iris.ca", sinks) {
  const rows = [];
  const sink = { name: "memory", write: async (e) => { rows.push(e); }, query: async () => rows };
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ user, sinks: sinks ?? [sink] }).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return { client, rows };
}

const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, json: r.isError ? null : JSON.parse(r.content[0].text), text: r.content[0].text };
};
const writes = (requests) => requests.filter((r) => r.method !== "GET" && !r.url.includes("/oauth/"));

const lead = (extra = {}) => ({ data: [{ id: "1", Notes_Description: "old note", ...extra }] });

test("Level B tools do not exist unless WRITES_B_ENABLED=true", async () => {
  await withEnv({ WRITES_B_ENABLED: undefined }, [], async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of B_TOOLS) assert.ok(!names.includes(t));
  });
});

test("Level B adds exactly the pairs, propose tools are read-only, none can delete", async () => {
  await withEnv({}, [], async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools.filter((t) => B_TOOLS.includes(t.name));
    assert.deepEqual(tools.map((t) => t.name).sort(), B_TOOLS);
    for (const t of tools) {
      assert.equal(t.annotations.readOnlyHint, t.name.includes("propose"));
      assert.doesNotMatch(t.name, /delete|remove|trash|destroy|purge|archive/i);
    }
  });
});

test("crm update: propose shows current → new, apply PUTs with the B token and logs old and new first", async () => {
  await withEnv({}, [["/crm/v2/Leads/1", (u, init) => (init.method === "PUT" ? Response.json({ data: [{ code: "SUCCESS", details: { id: "1" } }] }) : Response.json(lead()))]], async (requests) => {
    const { client, rows } = await connect();
    const changes = { Notes_Description: "new note" };
    const p = await call(client, "crm_propose_update", { module: "Leads", id: "1", changes });
    assert.deepEqual(p.json.changes, [{ field: "Notes_Description", current: "old note", new: "new note" }]);
    assert.equal(writes(requests).length, 0); // proposing writes nothing
    const a = await call(client, "crm_apply_update", { module: "Leads", id: "1", changes, confirmation_token: p.json.confirmation_token });
    assert.equal(a.isError, undefined);
    const [put] = writes(requests);
    assert.equal(put.method, "PUT");
    assert.deepEqual(JSON.parse(put.body), { data: [changes] });
    assert.match(put.headers.Authorization, /at-B-token/);
    const detail = rows.find((r) => r.params?.old);
    assert.deepEqual([detail.params.old, detail.params.new, detail.phase], [{ Notes_Description: "old note" }, changes, "before"]);
    const lastAfter = rows.map((r) => r.phase).lastIndexOf("after"); // the apply's own closing entry
    assert.ok(rows.indexOf(detail) < lastAfter); // old/new logged before acting
  });
});

test("crm update: no token, wrong token, other user's token or edited changes are refused", async () => {
  await withEnv({}, [["/crm/v2/Leads/1", lead()]], async (requests) => {
    const ana = (await connect("ana@iris.ca")).client;
    const bob = (await connect("bob@iris.ca")).client;
    const changes = { Notes_Description: "x" };
    const p = await call(ana, "crm_propose_update", { module: "Leads", id: "1", changes });
    const tok = p.json.confirmation_token;
    for (const args of [
      { module: "Leads", id: "1", changes, confirmation_token: "garbage" },
      { module: "Leads", id: "1", changes: { Notes_Description: "something else" }, confirmation_token: tok },
      { module: "Leads", id: "2", changes, confirmation_token: tok },
    ]) assert.equal((await call(ana, "crm_apply_update", args)).isError, true);
    assert.equal((await call(bob, "crm_apply_update", { module: "Leads", id: "1", changes, confirmation_token: tok })).isError, true);
    assert.equal(writes(requests).length, 0);
  });
});

test("crm update: fields outside the allowlist are rejected, and a record changed since the proposal is refused", async () => {
  let current = "old note";
  await withEnv({}, [["/crm/v2/Leads/1", () => Response.json(lead({ Notes_Description: current }))]], async (requests) => {
    const { client } = await connect();
    const bad = await call(client, "crm_propose_update", { module: "Leads", id: "1", changes: { Email: "x@y.z" } });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no permitidos/i);
    const changes = { Notes_Description: "new" };
    const p = await call(client, "crm_propose_update", { module: "Leads", id: "1", changes });
    current = "someone edited this";
    const a = await call(client, "crm_apply_update", { module: "Leads", id: "1", changes, confirmation_token: p.json.confirmation_token });
    assert.equal(a.isError, true);
    assert.match(a.text, /cambió desde la propuesta/);
    assert.equal(writes(requests).length, 0);
  });
});

test("crm create: duplicates block it (no token); otherwise propose then apply POSTs", async () => {
  let dup = true;
  await withEnv({}, [
    ["/Leads/search", () => (dup ? Response.json({ data: [{ id: "9", Last_Name: "Doe", Email: "a@b.c" }] }) : new Response(null, { status: 204 }))],
    ["/crm/v2/Leads", { data: [{ code: "SUCCESS", details: { id: "new1" } }] }],
  ], async (requests) => {
    const { client } = await connect();
    const fields = { Last_Name: "Doe", Email: "a@b.c" };
    const d = await call(client, "crm_propose_create", { module: "Leads", fields });
    assert.equal(d.json.duplicates.length, 1);
    assert.equal(d.json.confirmation_token, undefined);
    dup = false;
    const p = await call(client, "crm_propose_create", { module: "Leads", fields });
    assert.ok(p.json.confirmation_token);
    const a = await call(client, "crm_apply_create", { module: "Leads", fields, confirmation_token: p.json.confirmation_token });
    assert.equal(a.json.id, "new1");
    const [post] = writes(requests);
    assert.equal(post.method, "POST");
    assert.deepEqual(JSON.parse(post.body), { data: [fields] });
    dup = true; // a duplicate appearing between propose and apply stops the apply
    const again = await call(client, "crm_apply_create", { module: "Leads", fields, confirmation_token: p.json.confirmation_token });
    assert.equal(again.isError, true);
    assert.equal(writes(requests).length, 1);
    const noKey = await call(client, "crm_propose_create", { module: "Leads", fields: { Last_Name: "Doe" } });
    assert.equal(noKey.isError, true); // needs email or phone to check duplicates
  });
});

test("projects task change: propose, then apply as a form POST with the old state logged", async () => {
  const task = { tasks: [{ status: { id: "10", name: "Open" }, details: { owners: [{ id: "5", name: "Ana" }] } }] };
  await withEnv({}, [["/projects/7/tasks/9/", (u, init) => (init.method === "POST" ? Response.json({}) : Response.json(task))]], async (requests) => {
    const { client, rows } = await connect();
    const args = { project_id: "7", task_id: "9", status_id: "11", owner_id: "6" };
    const p = await call(client, "projects_propose_task_change", args);
    assert.equal(p.json.current.status, "Open");
    const a = await call(client, "projects_apply_task_change", { ...args, confirmation_token: p.json.confirmation_token });
    assert.equal(a.isError, undefined);
    const [post] = writes(requests);
    assert.equal(post.body.get("custom_status"), "11");
    assert.equal(post.body.get("person_responsible"), "6");
    assert.match(post.headers.Authorization, /at-B-token/);
    assert.equal(rows.find((r) => r.params?.old).params.old.status, "Open");
  });
});

test("a Level B apply does not run when the audit log cannot be written (fail-closed)", async () => {
  await withEnv({}, [["/crm/v2/Leads/1", lead()]], async (requests) => {
    let broken = false;
    const sink = { name: "s", write: async () => { if (broken) throw new Error("disk full"); } };
    const { client } = await connect("ana@iris.ca", [sink]);
    const changes = { Notes_Description: "n" };
    const p = await call(client, "crm_propose_update", { module: "Leads", id: "1", changes });
    broken = true;
    const a = await call(client, "crm_apply_update", { module: "Leads", id: "1", changes, confirmation_token: p.json.confirmation_token });
    assert.equal(a.isError, true);
    assert.equal(writes(requests).length, 0);
  });
});
