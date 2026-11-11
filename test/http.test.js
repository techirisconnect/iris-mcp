import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/http.js";
import { IrisOAuthProvider } from "../src/auth/provider.js";
import { memoryStore } from "../src/auth/store.js";

const freePort = () => new Promise((res) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

async function setup() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const store = memoryStore();
  await store.upsertUser({ email: "bob@iris.ca" }); // pre-approved, not admin
  const zoho = { email: "ana@iris.ca" }; // who "logs in" at Zoho in this test
  const fakeFetch = async (url) => {
    if (String(url).includes("/oauth/v2/token")) return Response.json({ access_token: "zoho-at" });
    if (String(url).includes("/oauth/user/info")) return Response.json({ Email: zoho.email, Display_Name: "T" });
    return new Response("nope", { status: 500 });
  };
  const provider = new IrisOAuthProvider({
    store, baseUrl: base, adminEmails: ["ana@iris.ca"], fetchImpl: fakeFetch,
    zoho: { clientId: "zid", clientSecret: "zsecret", accountsBase: "https://accounts.example" },
  });
  const rows = [];
  const sinks = [{ name: "memory", write: async (e) => { rows.push(e); }, query: async () => rows }];
  const server = createApp({ provider, baseUrl: base, sinks }).listen(port);
  const redirect = "http://localhost/cb";
  const reg = await (await fetch(`${base}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "t",
    }),
  })).json();

  /** Run the whole login; returns the final redirect URL (code or error). */
  async function login(email) {
    zoho.email = email;
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const a = await fetch(`${base}/authorize?` + new URLSearchParams({
      response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge,
      code_challenge_method: "S256", state: "st1", scope: "iris", resource: `${base}/mcp`,
    }), { redirect: "manual" });
    assert.equal(a.status, 302);
    const toZoho = new URL(a.headers.get("location"));
    assert.equal(toZoho.origin, "https://accounts.example");
    assert.equal(toZoho.searchParams.get("client_id"), "zid");
    const cb = await fetch(`${base}/zoho/callback?code=zc&state=${toZoho.searchParams.get("state")}`, { redirect: "manual" });
    assert.equal(cb.status, 302);
    return { back: new URL(cb.headers.get("location")), verifier };
  }
  const tokenReq = (body) => fetch(`${base}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: reg.client_id, ...body }),
  });
  async function tokens(email) {
    const { back, verifier } = await login(email);
    const code = back.searchParams.get("code");
    assert.ok(code, `expected code, got ${back}`);
    const r = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier });
    return { res: r, body: await r.json(), code, verifier };
  }
  return { base, store, rows, login, tokens, tokenReq, close: () => server.close() };
}

test("full flow: registration, Zoho login, token, MCP call attributed to the user", async () => {
  const t = await setup();
  try {
    const { body } = await t.tokens("Ana@IRIS.ca");
    assert.ok(body.access_token && body.refresh_token);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${body.access_token}` } },
    }));
    const { tools } = await client.listTools();
    assert.ok(tools.some((x) => x.name === "db_count"));
    await client.callTool({ name: "db_list_tables", arguments: {} });
    const entry = t.rows.find((r) => r.tool === "db_list_tables");
    assert.equal(entry.user, "ana@iris.ca"); // emails are normalised to lowercase
    await client.close();
  } finally { t.close(); }
});

test("audit_query follows the login: admins from ADMIN_EMAILS yes, other users no, AUDIT_ADMINS ignored", async () => {
  process.env.AUDIT_ADMINS = "bob@iris.ca"; // a stale value copied from a local .env must not matter
  const t = await setup();
  try {
    const run = async (email) => {
      const { body } = await t.tokens(email);
      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${body.access_token}` } },
      }));
      const r = await client.callTool({ name: "audit_query", arguments: {} });
      await client.close();
      return r;
    };
    assert.equal((await run("ana@iris.ca")).isError, undefined);
    assert.equal((await run("bob@iris.ca")).isError, true);
  } finally { delete process.env.AUDIT_ADMINS; t.close(); }
});

test("/mcp without a token is 401 with the resource metadata pointer", async () => {
  const t = await setup();
  try {
    const r = await fetch(`${t.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /resource_metadata=/);
    const meta = await (await fetch(`${t.base}/.well-known/oauth-authorization-server`)).json();
    assert.ok(meta.registration_endpoint && meta.token_endpoint);
  } finally { t.close(); }
});

test("a Zoho user that is not allowed gets access_denied and no code", async () => {
  const t = await setup();
  try {
    const { back } = await t.login("eve@elsewhere.com");
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "st1");
    assert.equal(back.searchParams.get("code"), null);
  } finally { t.close(); }
});

test("a pre-approved non-admin user can log in", async () => {
  const t = await setup();
  try {
    const { res } = await t.tokens("bob@iris.ca");
    assert.equal(res.status, 200);
  } finally { t.close(); }
});

test("revoking a user cuts off an already issued token immediately", async () => {
  const t = await setup();
  try {
    const { body } = await t.tokens("bob@iris.ca");
    const call = () => fetch(`${t.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${body.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal((await call()).status, 200);
    await t.store.upsertUser({ email: "bob@iris.ca", revoked: true });
    assert.equal((await call()).status, 401);
    const { back } = await t.login("bob@iris.ca"); // and he cannot log in again
    assert.equal(back.searchParams.get("error"), "access_denied");
  } finally { t.close(); }
});

test("authorization codes and refresh tokens are single use", async () => {
  const t = await setup();
  try {
    const { body, code, verifier } = await t.tokens("ana@iris.ca");
    const again = await t.tokenReq({ grant_type: "authorization_code", code, redirect_uri: "http://localhost/cb", code_verifier: verifier });
    assert.equal(again.status, 400);
    const r1 = await t.tokenReq({ grant_type: "refresh_token", refresh_token: body.refresh_token });
    assert.equal(r1.status, 200);
    const r2 = await t.tokenReq({ grant_type: "refresh_token", refresh_token: body.refresh_token });
    assert.equal(r2.status, 400);
  } finally { t.close(); }
});

test("a wrong PKCE verifier is rejected", async () => {
  const t = await setup();
  try {
    const { back } = await t.login("ana@iris.ca");
    const r = await t.tokenReq({
      grant_type: "authorization_code", code: back.searchParams.get("code"),
      redirect_uri: "http://localhost/cb", code_verifier: "x".repeat(50),
    });
    assert.equal(r.status, 400);
  } finally { t.close(); }
});
