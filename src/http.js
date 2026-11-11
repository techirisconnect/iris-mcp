#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./index.js"; // also loads .env
import { IrisOAuthProvider } from "./auth/provider.js";
import { pgStore } from "./auth/store.js";

// Remote (streamable HTTP) entry point. Same tools as stdio, but every request carries a
// bearer token issued by our own OAuth server after a Zoho login, so each call is
// attributed to a person (audit log) and access can be revoked per user.

const SCOPES = ["iris"];

export function createApp({ provider, baseUrl, sinks }) {
  const app = express();
  app.set("trust proxy", 1); // Render terminates TLS in front of us
  app.disable("x-powered-by");

  const base = new URL(baseUrl);
  const mcpUrl = new URL("/mcp", base);

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: base,
    baseUrl: base,
    resourceServerUrl: mcpUrl,
    scopesSupported: SCOPES,
    resourceName: "IRIS",
  }));
  app.get("/zoho/callback", provider.handleZohoCallback);

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  // Stateless: a fresh server per request, bound to the authenticated user.
  app.post("/mcp", express.json({ limit: "1mb" }), bearer, async (req, res) => {
    const { email, isAdmin } = req.auth.extra;
    const server = createServer({ user: email, isAdmin: () => isAdmin === true, ...(sinks && { sinks }) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp error:", e.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req, res) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
}

export function providerFromEnv() {
  requireEnv("BASE_URL", "ZOHO_LOGIN_CLIENT_ID", "ZOHO_LOGIN_CLIENT_SECRET", "AUTH_DATABASE_URL", "ADMIN_EMAILS");
  return new IrisOAuthProvider({
    store: pgStore(),
    baseUrl: process.env.BASE_URL,
    zoho: {
      clientId: process.env.ZOHO_LOGIN_CLIENT_ID,
      clientSecret: process.env.ZOHO_LOGIN_CLIENT_SECRET,
      accountsBase: process.env.Z_ACCOUNTS_BASE || "https://accounts.zohocloud.ca",
    },
    adminEmails: process.env.ADMIN_EMAILS.split(","),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({ provider: providerFromEnv(), baseUrl: process.env.BASE_URL });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.error(`iris-mcp ready (http) on :${port}, base ${process.env.BASE_URL}`));
}
