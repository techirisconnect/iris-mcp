#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCrm } from "./tools/crm.js";
import { registerCliq } from "./tools/cliq.js";
import { registerWorkDrive } from "./tools/workdrive.js";
import { registerDb } from "./tools/db.js";
import { registerSign } from "./tools/sign.js";
import { registerProjects } from "./tools/projects.js";
import { registerWrites } from "./tools/write.js";
import { registerWritesB } from "./tools/writeb.js";
import { auditServer, registerAuditQuery } from "./audit.js";

// Load .env next to the package (quiet: stdout is reserved for the MCP protocol).
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

/** opts: { user, sinks } — user comes from the authenticated session once the server is remote. */
export function createServer(opts = {}) {
  const server = new McpServer({ name: "iris", version: "0.2.0" });
  const audit = auditServer(server, opts); // must run before any registerTool
  registerAuditQuery(server, audit);
  registerCrm(server);
  registerCliq(server);
  registerWorkDrive(server);
  registerDb(server);
  registerSign(server);
  registerProjects(server);
  // Write tools exist only when explicitly enabled (and use a separate write token).
  if (process.env.WRITES_ENABLED === "true") registerWrites(server, audit);
  // Level B (updates/creates, two-step confirmation) has its own switch and its own token.
  if (process.env.WRITES_B_ENABLED === "true") registerWritesB(server, audit);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createServer().connect(new StdioServerTransport());
  console.error("iris-mcp ready (stdio)");
}
