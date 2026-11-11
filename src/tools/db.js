import { z } from "zod";
import pg from "pg";
import { safe } from "../util.js";

// Read-only access to the IRIS Postgres (Supabase) database through a role that
// only has SELECT (see sql/create-readonly-role.sql). The role is the real
// guarantee; the allowlist and column checks below are a second layer.
// Override the table allowlist with DB_ALLOWED_TABLES=a,b,c.
const DEFAULT_TABLES = [
  "properties",
  "rental_managers",
  "leases",
  "tenants",
  "maintenance_requests",
  "property_tenant_waitlist",
];
const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SENSITIVE_RE = /pass(word)?|token|secret|hash|api_?key/i;
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

export const allowedTables = () =>
  (process.env.DB_ALLOWED_TABLES ? process.env.DB_ALLOWED_TABLES.split(",") : DEFAULT_TABLES)
    .map((t) => t.trim())
    .filter(Boolean);

let pool = null;
function db() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL_READONLY;
  if (!url) throw new Error("Base de datos no configurada: falta DATABASE_URL_READONLY");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  pool = new pg.Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000, // fail fast instead of hanging the tool call
    ssl: local ? false : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("pg pool error:", e.message));
  return pool;
}

const q = (ident) => `"${ident.replace(/"/g, '""')}"`; // identifiers are also regex-checked

function checkTable(table) {
  if (!allowedTables().includes(table)) {
    throw new Error(`Tabla no permitida: ${table}. Permitidas: ${allowedTables().join(", ")}`);
  }
}

function checkColumns(cols) {
  for (const c of cols) {
    if (!COLUMN_RE.test(c)) throw new Error(`Columna inválida: ${c}`);
    if (SENSITIVE_RE.test(c)) throw new Error(`Columna sensible no permitida: ${c}`);
  }
}

/** Build the WHERE clause with positional parameters. */
export function buildWhere(filters, values = []) {
  const parts = filters.map(({ column, op, value }) => {
    if (op === "is") {
      if (value === null) return `${q(column)} IS NULL`;
      if (typeof value === "boolean") return `${q(column)} IS ${value ? "TRUE" : "FALSE"}`;
      throw new Error("op 'is' acepta solo null, true o false");
    }
    if (op === "in") {
      if (!Array.isArray(value)) throw new Error("op 'in' requiere un array");
      values.push(value);
      return `${q(column)} = ANY($${values.length})`;
    }
    if (value === null || Array.isArray(value)) throw new Error(`op '${op}' no acepta null ni arrays`);
    values.push(value);
    return `${q(column)} ${OPS[op]} $${values.length}`;
  });
  return { sql: parts.length ? ` WHERE ${parts.join(" AND ")}` : "", values };
}

export function buildSelect({ table, columns, filters, order_by, ascending, limit }) {
  const { sql: where, values } = buildWhere(filters);
  const order = order_by ? ` ORDER BY ${q(order_by)} ${ascending ? "ASC" : "DESC"}` : "";
  return {
    text: `SELECT ${columns.map(q).join(", ")} FROM public.${q(table)}${where}${order} LIMIT ${Number(limit)}`,
    values,
  };
}

/** Columns the role may read (column-level grants hide the rest), minus sensitive-looking names. */
const columnCache = new Map();
async function readableColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const { rows } = await db().query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND has_column_privilege(current_user, format('public.%I', table_name), column_name, 'SELECT')
      ORDER BY ordinal_position`,
    [table],
  );
  const cols = rows.map((r) => r.column_name).filter((c) => !SENSITIVE_RE.test(c));
  if (!cols.length) throw new Error(`El rol no tiene permisos de lectura sobre ${table}`);
  columnCache.set(table, cols);
  return cols;
}

const filterSchema = z.object({
  column: z.string(),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]),
});

export function registerDb(server) {
  server.registerTool(
    "db_list_tables",
    { description: "List the IRIS database tables this MCP can read.", inputSchema: {}, annotations: { readOnlyHint: true } },
    safe(async () => allowedTables()),
  );

  server.registerTool(
    "db_query",
    {
      description:
        "Read rows from an allowed IRIS table (read-only). Use filters for conditions; max 200 rows. Sensitive columns (password/token/secret/hash) are never returned.",
      inputSchema: {
        table: z.string(),
        columns: z.array(z.string()).optional().describe("Columns to return; omit for all readable columns"),
        filters: z.array(filterSchema).default([]),
        order_by: z.string().optional(),
        ascending: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ table, columns, filters, order_by, ascending, limit }) => {
      checkTable(table);
      if (columns?.length) checkColumns(columns);
      checkColumns(filters.map((f) => f.column));
      if (order_by) checkColumns([order_by]);

      const cols = columns?.length ? columns : await readableColumns(table);
      const { text, values } = buildSelect({ table, columns: cols, filters, order_by, ascending, limit });
      const { rows } = await db().query(text, values);
      return { count: rows.length, rows };
    }),
  );

  server.registerTool(
    "db_count",
    {
      description: "Count rows in an allowed IRIS table, optionally filtered.",
      inputSchema: { table: z.string(), filters: z.array(filterSchema).default([]) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ table, filters }) => {
      checkTable(table);
      checkColumns(filters.map((f) => f.column));
      const { sql, values } = buildWhere(filters);
      const { rows } = await db().query(`SELECT count(*)::int AS count FROM public.${q(table)}${sql}`, values);
      return { table, count: rows[0].count };
    }),
  );
}
