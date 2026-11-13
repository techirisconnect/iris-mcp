import crypto from "node:crypto";
import pg from "pg";

// Persistence for the OAuth layer (clients, pending logins, auth codes, tokens, users).
// Two implementations with the same interface: memory (tests / local) and Postgres
// (production, so a redeploy does not log everyone out). Nothing here ever deletes rows:
// codes and tokens are marked used/revoked, users are marked revoked.
// Tokens and codes are stored only as SHA-256 hashes.

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export function memoryStore() {
  const clients = new Map(), pending = new Map(), codes = new Map(), tokens = new Map(), users = new Map();
  const live = (row) => row && !row.used && row.expiresAt > Date.now();
  return {
    name: "memory",
    async getClient(id) { return clients.get(id); },
    async saveClient(info) { clients.set(info.client_id, info); },
    async savePending(txn, data, expiresAt) { pending.set(sha256(txn), { data, expiresAt, used: false }); },
    async takePending(txn) {
      const row = pending.get(sha256(txn));
      if (!live(row)) return undefined;
      row.used = true;
      return row.data;
    },
    async saveCode(code, data, expiresAt) { codes.set(sha256(code), { data, expiresAt, used: false }); },
    async takeCode(code) {
      const row = codes.get(sha256(code));
      if (!live(row)) return undefined;
      row.used = true;
      return row.data;
    },
    /** Read a code without consuming it (PKCE challenge lookup). */
    async peekCode(code) {
      const row = codes.get(sha256(code));
      return live(row) ? row.data : undefined;
    },
    async saveToken(token, data) { tokens.set(sha256(token), { ...data, revoked: false }); },
    async getToken(token) { return tokens.get(sha256(token)); },
    /** Atomically revoke; returns the row only if it was still active (refresh rotation). */
    async takeToken(token) {
      const row = tokens.get(sha256(token));
      if (!row || row.revoked) return undefined;
      row.revoked = true;
      return row;
    },
    async revokeToken(token) { const r = tokens.get(sha256(token)); if (r) r.revoked = true; },
    async revokeUserTokens(email) { for (const r of tokens.values()) if (r.email === email) r.revoked = true; },
    async getUser(email) { return users.get(email); },
    async upsertUser(user) {
      const prev = users.get(user.email) || {};
      const next = { revoked: false, is_admin: false, ...prev, ...user };
      users.set(user.email, next);
      return next;
    },
  };
}

export function pgStore(url = process.env.AUTH_DATABASE_URL) {
  if (!url) throw new Error("Falta AUTH_DATABASE_URL (tablas de login, ver sql/create-auth-tables.sql)");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("auth pool error:", e.message));
  const one = async (text, values) => (await pool.query(text, values)).rows[0];
  const ts = (ms) => new Date(ms);
  const tokenRow = (r) => r && ({
    kind: r.kind, clientId: r.client_id, email: r.email, scopes: r.scopes, resource: r.resource || undefined,
    expiresAt: new Date(r.expires_at).getTime(), revoked: !!r.revoked_at,
  });
  return {
    name: "postgres",
    async getClient(id) { return (await one("SELECT info FROM public.mcp_oauth_clients WHERE client_id = $1", [id]))?.info; },
    async saveClient(info) {
      await pool.query("INSERT INTO public.mcp_oauth_clients (client_id, info) VALUES ($1, $2)", [info.client_id, info]);
    },
    async savePending(txn, data, expiresAt) {
      await pool.query("INSERT INTO public.mcp_oauth_pending (txn_hash, data, expires_at) VALUES ($1,$2,$3)", [sha256(txn), data, ts(expiresAt)]);
    },
    async takePending(txn) {
      return (await one(
        "UPDATE public.mcp_oauth_pending SET used_at = now() WHERE txn_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING data",
        [sha256(txn)],
      ))?.data;
    },
    async saveCode(code, data, expiresAt) {
      await pool.query("INSERT INTO public.mcp_oauth_codes (code_hash, data, expires_at) VALUES ($1,$2,$3)", [sha256(code), data, ts(expiresAt)]);
    },
    async takeCode(code) {
      return (await one(
        "UPDATE public.mcp_oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING data",
        [sha256(code)],
      ))?.data;
    },
    async peekCode(code) {
      return (await one(
        "SELECT data FROM public.mcp_oauth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()",
        [sha256(code)],
      ))?.data;
    },
    async saveToken(token, d) {
      await pool.query(
        "INSERT INTO public.mcp_oauth_tokens (token_hash, kind, client_id, email, scopes, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [sha256(token), d.kind, d.clientId, d.email, d.scopes, d.resource || null, ts(d.expiresAt)],
      );
    },
    async getToken(token) {
      return tokenRow(await one("SELECT * FROM public.mcp_oauth_tokens WHERE token_hash = $1", [sha256(token)]));
    },
    async takeToken(token) {
      return tokenRow(await one(
        "UPDATE public.mcp_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING *",
        [sha256(token)],
      ));
    },
    async revokeToken(token) {
      await pool.query("UPDATE public.mcp_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha256(token)]);
    },
    async revokeUserTokens(email) {
      await pool.query("UPDATE public.mcp_oauth_tokens SET revoked_at = now() WHERE email = $1 AND revoked_at IS NULL", [email]);
    },
    async getUser(email) {
      const r = await one("SELECT email, name, is_admin, db_enabled, revoked_at FROM public.mcp_users WHERE email = $1", [email]);
      return r && { email: r.email, name: r.name, is_admin: r.is_admin, db_enabled: r.db_enabled, revoked: !!r.revoked_at };
    },
    async upsertUser(u) {
      const r = await one(
        `INSERT INTO public.mcp_users (email, name, is_admin, last_login_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, public.mcp_users.name), last_login_at = now()
         RETURNING email, name, is_admin, db_enabled, revoked_at`,
        [u.email, u.name ?? null, !!u.is_admin],
      );
      return { email: r.email, name: r.name, is_admin: r.is_admin, db_enabled: r.db_enabled, revoked: !!r.revoked_at };
    },
  };
}
