import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { ok, fail, safe, clip } from "./util.js";

// Audit log: every tool call is recorded (who, when, tool, system, kind, params,
// outcome, result count, duration). Read results are NEVER stored, only their count.
// Sinks: JSON-lines file (always) and Postgres table mcp_audit_log (when
// AUDIT_DATABASE_URL is set, role with INSERT/SELECT only: sql/create-audit-table.sql).
// Write tools (readOnlyHint !== true) are fail-closed: if the "attempt" entry cannot be
// stored, the tool does not run.

const SECRET_KEY_RE = /pass(word)?|token|secret|hash|api_?key|authorization/i;

// Reads keep short params; writes keep up to 2000 chars per field so the log shows what was written.
export function redact(value, depth = 0, max = 200) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return clip(value, max);
  if (typeof value !== "object") return value;
  if (depth > 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1, max));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1, max)]),
  );
}

export const systemOf = (tool) => tool.split("_")[0];

/** Number of results in a tool response, without keeping the data. */
export function countResults(result) {
  try {
    const parsed = JSON.parse(result?.content?.[0]?.text);
    if (Array.isArray(parsed)) return parsed.length;
    if (typeof parsed?.count === "number") return parsed.count;
    for (const k of ["data", "requests", "tasks", "rows", "channels", "messages", "files", "members"]) {
      if (Array.isArray(parsed?.[k])) return parsed[k].length;
    }
    return parsed ? 1 : 0;
  } catch {
    return undefined;
  }
}

const defaultUser = () => process.env.IRIS_USER || os.userInfo().username;

// --- sinks ---

export function fileSink(file = process.env.AUDIT_LOG_FILE) {
  const target = path.resolve(file || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "logs", "audit.jsonl"));
  return {
    name: "file",
    async write(entry) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, JSON.stringify(entry) + "\n");
    },
    async query({ limit = 50, user, tool, outcome, since }) {
      if (!fs.existsSync(target)) return [];
      const rows = fs.readFileSync(target, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return rows
        .filter((r) => (!user || r.user === user) && (!tool || r.tool === tool) && (!outcome || r.outcome === outcome) && (!since || r.ts >= since))
        .slice(-limit)
        .reverse();
    },
  };
}

let auditPool = null;
export function pgSink(url = process.env.AUDIT_DATABASE_URL) {
  if (!url) return null;
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  auditPool ??= new pg.Pool({
    connectionString: url, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000,
    ssl: local ? false : { rejectUnauthorized: false },
  });
  return {
    name: "postgres",
    async write(e) {
      await auditPool.query(
        `INSERT INTO public.mcp_audit_log (ts, "user", tool, system, kind, params, outcome, error, result_count, duration_ms, phase)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [e.ts, e.user, e.tool, e.system, e.kind, e.params, e.outcome, e.error ?? null, e.result_count ?? null, e.duration_ms ?? null, e.phase],
      );
    },
    async query({ limit = 50, user, tool, outcome, since }) {
      const where = [], vals = [];
      const add = (sql, v) => { vals.push(v); where.push(sql.replace("?", `$${vals.length}`)); };
      if (user) add(`"user" = ?`, user);
      if (tool) add("tool = ?", tool);
      if (outcome) add("outcome = ?", outcome);
      if (since) add("ts >= ?", since);
      vals.push(limit);
      const { rows } = await auditPool.query(
        `SELECT * FROM public.mcp_audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT $${vals.length}`,
        vals,
      );
      return rows;
    },
  };
}

export function defaultSinks() {
  return [fileSink(), pgSink()].filter(Boolean);
}

// --- wrapper ---

/**
 * Wrap server.registerTool so every handler is audited. Call before registering tools.
 * opts: { user: string | () => string, sinks: [] }
 */
export function auditServer(server, opts = {}) {
  const sinks = opts.sinks ?? defaultSinks();
  const getUser = typeof opts.user === "function" ? opts.user : () => opts.user || defaultUser();
  const original = server.registerTool.bind(server);

  const record = async (entry, { strict }) => {
    const results = await Promise.allSettled(sinks.map((s) => s.write(entry)));
    const failed = results.filter((r) => r.status === "rejected");
    failed.forEach((r) => console.error("audit sink error:", r.reason?.message));
    // strict: all sinks must succeed (writes). Non-strict: at least don't break the tool.
    if (strict && (failed.length > 0 || sinks.length === 0)) throw new Error("No se pudo registrar la auditoría; acción cancelada");
  };

  server.registerTool = (name, config, handler) => {
    const readOnly = config?.annotations?.readOnlyHint === true;
    const wrapped = async (args, extra) => {
      const base = {
        user: getUser(), tool: name, system: systemOf(name),
        kind: readOnly ? "read" : "write", params: redact(args ?? {}, 0, readOnly ? 200 : 2000),
      };
      const started = Date.now();
      if (!readOnly) {
        try {
          await record({ ...base, ts: new Date().toISOString(), outcome: "attempt", phase: "before" }, { strict: true });
        } catch (e) {
          return fail(e);
        }
      }
      let result;
      try {
        result = await handler(args, extra);
      } catch (e) {
        result = fail(e);
      }
      await record({
        ...base, ts: new Date().toISOString(), phase: "after",
        outcome: result?.isError ? "error" : "ok",
        error: result?.isError ? clip(result.content?.[0]?.text, 300) : undefined,
        result_count: result?.isError ? undefined : countResults(result),
        duration_ms: Date.now() - started,
      }, { strict: false }).catch(() => {});
      return result;
    };
    return original(name, config, wrapped);
  };

  // `record` lets a tool store an extra entry (e.g. old and new values) before it acts; it
  // throws if any sink fails, so the caller can abort (fail-closed).
  const recordStrict = (partial) =>
    record({ user: getUser(), kind: "write", ts: new Date().toISOString(), ...partial, params: redact(partial.params ?? {}, 0, 2000) }, { strict: true });

  // Rows this person already read through `tool` since `since` (ISO), from the audit log, for daily quotas.
  const usage = async ({ tool, since }) => {
    const sink = sinks.find((s) => s.name === "postgres") ?? sinks[0];
    if (!sink) throw new Error("No hay destino de auditoría configurado");
    const rows = await sink.query({ user: getUser(), tool, outcome: "ok", since, limit: 5000 });
    return rows.reduce((n, r) => n + (Number(r.result_count) || 0), 0);
  };

  return { sinks, getUser, isAdmin: opts.isAdmin, record: recordStrict, usage };
}

// --- admin-only query tool ---

export function registerAuditQuery(server, { sinks, getUser, isAdmin }) {
  const admins = () => (process.env.AUDIT_ADMINS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  server.registerTool(
    "audit_query",
    {
      description: "Query the IRIS MCP audit log (admins only). Returns who called which tool, when, with what parameters and outcome. Never contains the data that was read.",
      inputSchema: {
        user: z.string().optional(),
        tool: z.string().optional(),
        outcome: z.enum(["ok", "error", "attempt"]).optional(),
        since: z.string().optional().describe("ISO date, e.g. 2026-11-01"),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (args) => {
      // Remote mode: the login decides (mcp_users.is_admin or ADMIN_EMAILS). Local mode: AUDIT_ADMINS.
      const allowed = typeof isAdmin === "function" ? isAdmin() : admins().includes(String(getUser()).toLowerCase());
      if (!allowed) {
        throw new Error("audit_query es solo para administradores");
      }
      const sink = sinks.find((s) => s.name === "postgres") ?? sinks[0];
      if (!sink) throw new Error("No hay destino de auditoría configurado");
      const rows = await sink.query(args);
      return { count: rows.length, source: sink.name, entries: rows };
    }),
  );
}
