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

// Load .env next to the package (quiet: stdout is reserved for the MCP protocol).
dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  quiet: true,
});

export function createServer() {
  const server = new McpServer({ name: "iris", version: "0.1.0" });
  registerCrm(server);
  registerCliq(server);
  registerWorkDrive(server);
  registerDb(server);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createServer().connect(new StdioServerTransport());
  console.error("iris-mcp ready (stdio)");
}
