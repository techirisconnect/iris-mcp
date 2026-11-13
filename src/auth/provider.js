import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { randomToken } from "./store.js";

// OAuth authorization server for the IRIS MCP. Claude connects to *us* (we support dynamic
// client registration, which Zoho does not); the person proves who they are by logging in
// with Zoho, and only users present and not revoked in mcp_users get a token.
// Revocation is immediate: the user is re-checked on every request.

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SCOPES = ["iris"];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class IrisOAuthProvider {
  /**
   * @param {object} o
   * @param {object} o.store         see auth/store.js
   * @param {string} o.baseUrl       public https URL of this server (no trailing slash)
   * @param {object} o.zoho          { clientId, clientSecret, accountsBase }  (login-only "Server-based" client)
   * @param {string[]} [o.adminEmails]  always allowed, and created as admins on first login
   * @param {Function} [o.fetchImpl]
   */
  constructor({ store, baseUrl, zoho, adminEmails = [], fetchImpl = (...a) => fetch(...a) }) {
    this.store = store;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.zoho = zoho;
    this.adminEmails = new Set(adminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    this.fetch = fetchImpl;
    this.redirectUri = `${this.baseUrl}/zoho/callback`;
  }

  get clientsStore() {
    return {
      getClient: (id) => this.store.getClient(id),
      registerClient: async (info) => { await this.store.saveClient(info); return info; },
    };
  }

  // Step 1: Claude sent the person here. Park the request and send them to Zoho to log in.
  async authorize(client, params, res) {
    const txn = randomToken();
    await this.store.savePending(txn, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes?.length ? params.scopes : DEFAULT_SCOPES,
      resource: params.resource?.href,
    }, Date.now() + PENDING_TTL_MS);
    const url = new URL(`${this.zoho.accountsBase}/oauth/v2/auth`);
    url.search = new URLSearchParams({
      client_id: this.zoho.clientId,
      response_type: "code",
      scope: "openid email profile",
      redirect_uri: this.redirectUri,
      state: txn,
      access_type: "online",
    }).toString();
    res.redirect(url.toString());
  }

  async zohoIdentity(code) {
    const tokenRes = await this.fetch(`${this.zoho.accountsBase}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.zoho.clientId,
        client_secret: this.zoho.clientSecret,
        redirect_uri: this.redirectUri,
        code,
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tok.access_token) throw new Error(`Zoho rechazó el login (${tok.error || tokenRes.status})`);
    const infoRes = await this.fetch(`${this.zoho.accountsBase}/oauth/user/info`, {
      headers: { Authorization: `Zoho-oauthtoken ${tok.access_token}` },
    });
    const info = await infoRes.json().catch(() => ({}));
    let email = info.Email || info.email;
    let name = info.Display_Name || info.name;
    if (!email && tok.id_token) {
      // id_token arrives straight from Zoho over TLS in this exchange; read its claims.
      const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString());
      email = claims.email;
      name ||= claims.name;
    }
    if (!email) throw new Error("Zoho no devolvió un email para este usuario");
    return { email: String(email).trim().toLowerCase(), name };
  }

  async allow(email, name) {
    const isEnvAdmin = this.adminEmails.has(email);
    let user = await this.store.getUser(email);
    if (!user && isEnvAdmin) user = await this.store.upsertUser({ email, name, is_admin: true });
    if (!user || user.revoked) return undefined;
    return this.store.upsertUser({ email, name }); // refresh last login
  }

  // Step 2: Zoho sent the person back with a code. Express route handler.
  handleZohoCallback = async (req, res) => {
    const { code, state, error } = req.query;
    try {
      const pending = state ? await this.store.takePending(String(state)) : undefined;
      if (!pending) {
        res.status(400).type("html").send("<h1>El inicio de sesión venció</h1><p>Volvé a conectar desde Claude.</p>");
        return;
      }
      const back = (params) => {
        const u = new URL(pending.redirectUri);
        for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
        res.redirect(u.toString());
      };
      if (error || !code) return back({ error: "access_denied", error_description: "Login cancelado", state: pending.state });
      const { email, name } = await this.zohoIdentity(String(code));
      const user = await this.allow(email, name);
      if (!user) {
        console.error(`login denied: ${email}`);
        return back({ error: "access_denied", error_description: "Tu usuario no tiene acceso al MCP de IRIS", state: pending.state });
      }
      const authCode = randomToken();
      await this.store.saveCode(authCode, {
        clientId: pending.clientId, email, codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri, scopes: pending.scopes, resource: pending.resource,
      }, Date.now() + CODE_TTL_MS);
      back({ code: authCode, state: pending.state });
    } catch (e) {
      console.error("zoho callback error:", e.message);
      res.status(502).type("html").send(`<h1>No se pudo iniciar sesión</h1><p>${esc(e.message)}</p>`);
    }
  };

  async challengeForAuthorizationCode(client, code) {
    const data = await this.store.peekCode(code);
    if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return data.codeChallenge;
  }

  async issue({ clientId, email, scopes, resource }) {
    const access = randomToken(), refresh = randomToken(), now = Date.now();
    await this.store.saveToken(access, { kind: "access", clientId, email, scopes, resource, expiresAt: now + ACCESS_TTL_MS });
    await this.store.saveToken(refresh, { kind: "refresh", clientId, email, scopes, resource, expiresAt: now + REFRESH_TTL_MS });
    return {
      access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refresh, scope: scopes.join(" "),
    };
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const data = await this.store.takeCode(code);
    if (!data || data.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri && redirectUri !== data.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    const user = await this.store.getUser(data.email);
    if (!user || user.revoked) throw new InvalidGrantError("Access revoked");
    return this.issue({ clientId: client.client_id, email: data.email, scopes: data.scopes, resource: data.resource });
  }

  async exchangeRefreshToken(client, refreshToken) {
    const row = await this.store.takeToken(refreshToken); // rotation: each refresh token works once
    if (!row || row.kind !== "refresh" || row.clientId !== client.client_id || row.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const user = await this.store.getUser(row.email);
    if (!user || user.revoked) throw new InvalidGrantError("Access revoked");
    return this.issue({ clientId: row.clientId, email: row.email, scopes: row.scopes, resource: row.resource });
  }

  async verifyAccessToken(token) {
    let row;
    try {
      row = await this.store.getToken(token);
    } catch (e) {
      throw new ServerError(`Token store unavailable: ${e.message}`);
    }
    if (!row || row.kind !== "access" || row.revoked || row.expiresAt < Date.now()) throw new InvalidTokenError("Invalid or expired token");
    const user = await this.store.getUser(row.email);
    if (!user || user.revoked) throw new InvalidTokenError("Access revoked");
    return {
      token, clientId: row.clientId, scopes: row.scopes, expiresAt: Math.floor(row.expiresAt / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: {
        email: row.email,
        isAdmin: !!user.is_admin || this.adminEmails.has(row.email),
        // Database tools are opt-in per person (mcp_users.db_enabled); admins always have them.
        dbEnabled: !!user.is_admin || this.adminEmails.has(row.email) || !!user.db_enabled,
      },
    };
  }

  async revokeToken(_client, request) {
    await this.store.revokeToken(request.token);
  }
}
