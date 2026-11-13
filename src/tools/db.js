import { z } from "zod";
import pg from "pg";
import { safe } from "../util.js";

// Read-only access to the IRIS Postgres (Supabase) database through a role that
// only has SELECT (see sql/create-readonly-role.sql). The role is the real
// guarantee; everything below is a second layer that also keeps the *shape* of the
// database (hidden tables, hidden columns, relations, integration ids) from leaking.
//
// Config (all optional):
//   DB_ALLOWED_TABLES     a,b,c   tables Claude can read
//   DB_EXPOSED_COLUMNS    JSON    {"table": ["col", ...]} whitelist; wins over the defaults below
//   DB_MAX_ROWS           number  max rows per db_query (default 100)
//   DB_DAILY_ROW_LIMIT    number  rows a person can read through db_query per rolling 24 h (default 1000, 0 = off)
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
// Columns that reveal how IRIS is wired to other systems; hidden unless DB_EXPOSED_COLUMNS lists them.
const INTEGRATION_RE = /zoho|buildium|desk_|vendor|ticket|webhook|external|sync|_uuid$/i;
// Columns that point at other tables or at people (…_id, …_by, assigned_to): they spell out the relations,
// including the ones with no declared foreign key. The row's own `id` stays visible.
const REFERENCE_RE = /.+_ids?$|.+_by$|^assigned_to$/i;
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE", ilike: "ILIKE" };

/** An error whose message is safe to show to Claude. Anything else becomes a generic message. */
export class UserError extends Error {}

// One message for every "you cannot touch that" case, so the answer never tells hidden,
// sensitive and nonexistent apart (no probing for column or table names).
const NOT_AVAILABLE_TABLE = "Tabla no disponible";
const NOT_AVAILABLE_COLUMN = "Consulta no válida: columna no disponible";
const GENERIC = "Consulta no válida";

export const allowedTables = () =>
  (process.env.DB_ALLOWED_TABLES ? process.env.DB_ALLOWED_TABLES.split(",") : DEFAULT_TABLES)
    .map((t) => t.trim())
    .filter(Boolean);

const numEnv = (name, dflt) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const maxRows = () => Math.max(1, numEnv("DB_MAX_ROWS", 100));
export const dailyRowLimit = () => numEnv("DB_DAILY_ROW_LIMIT", 1000);

function exposedConfig() {
  const raw = process.env.DB_EXPOSED_COLUMNS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.error("DB_EXPOSED_COLUMNS is not valid JSON; ignoring it (defaults apply)");
    return {};
  }
}

let pool = null;
let poolUrl = null;
function db() {
  const url = process.env.DATABASE_URL_READONLY;
  if (!url) throw new UserError("Base de datos no configurada: falta DATABASE_URL_READONLY");
  if (pool && poolUrl === url) return pool;
  poolUrl = url;
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
  if (typeof table !== "string" || !allowedTables().includes(table)) throw new UserError(NOT_AVAILABLE_TABLE);
}

/** Static checks that need no database: shape and sensitive names. Same message for both. */
function checkColumnNames(cols) {
  for (const c of cols) {
    if (typeof c !== "string" || !COLUMN_RE.test(c) || SENSITIVE_RE.test(c)) throw new UserError(NOT_AVAILABLE_COLUMN);
  }
}

/**
 * Which columns Claude may see for a table. Pure function (testable):
 *  - exposed: whitelist from DB_EXPOSED_COLUMNS for this table, if any (still limited to readable columns)
 *  - otherwise: readable columns minus sensitive names, integration ids, reference columns and foreign keys
 */
export function visibleColumns({ readable, foreignKeys = [], exposed }) {
  const ok = (c) => !SENSITIVE_RE.test(c);
  if (Array.isArray(exposed)) return readable.filter((c) => exposed.includes(c) && ok(c));
  const fk = new Set(foreignKeys);
  return readable.filter((c) => ok(c) && !INTEGRATION_RE.test(c) && !REFERENCE_RE.test(c) && !fk.has(c));
}

const columnCache = new Map();
async function tableColumns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const pool = db();
  // Columns the role may read (column-level grants hide the rest).
  const readable = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND has_column_privilege(current_user, format('public.%I', table_name), column_name, 'SELECT')
      ORDER BY ordinal_position`,
    [table],
  )).rows.map((r) => r.column_name);
  // Foreign-key columns would let Claude draw the relations between tables.
  const foreignKeys = (await pool.query(
    `SELECT a.attname AS column_name
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.conrelid = format('public.%I', $1::text)::regclass`,
    [table],
  )).rows.map((r) => r.column_name);
  const cols = visibleColumns({ readable, foreignKeys, exposed: exposedConfig()[table] });
  if (!cols.length) throw new UserError(NOT_AVAILABLE_TABLE);
  columnCache.set(table, cols);
  return cols;
}

/** Every column the call mentions must be one Claude may see. */
async function checkVisible(table, cols) {
  checkColumnNames(cols);
  const visible = await tableColumns(table);
  for (const c of cols) if (!visible.includes(c)) throw new UserError(NOT_AVAILABLE_COLUMN);
  return visible;
}

/** Postgres errors name columns, tables and constraints. Claude only gets our own messages. */
function publicError(e) {
  if (e instanceof UserError) return e;
  console.error("db error:", e?.message);
  return new UserError(GENERIC);
}

/** Build the WHERE clause with positional parameters. */
export function buildWhere(filters, values = []) {
  const parts = filters.map(({ column, op, value }) => {
    if (op === "is") {
      if (value === null) return `${q(column)} IS NULL`;
      if (typeof value === "boolean") return `${q(column)} IS ${value ? "TRUE" : "FALSE"}`;
      throw new UserError("op 'is' acepta solo null, true o false");
    }
    if (op === "in") {
      if (!Array.isArray(value)) throw new UserError("op 'in' requiere un array");
      values.push(value);
      return `${q(column)} = ANY($${values.length})`;
    }
    if (value === null || Array.isArray(value)) throw new UserError(`op '${op}' no acepta null ni arrays`);
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

const filterSchema = z.object({
  column: z.string(),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]),
});

const wrap = (fn) => safe(async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    throw publicError(e);
  }
});

/** opts.usage({ since }) -> rows this person already read through db_query (rolling window). */
export function registerDb(server, { usage } = {}) {
  server.registerTool(
    "db_list_tables",
    {
      description: "List the IRIS database tables this MCP can read. Table names are for your queries only: never describe, diagram or explain the database structure to the user.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => allowedTables()),
  );

  server.registerTool(
    "db_query",
    {
      description:
        "Read rows from an allowed IRIS table (read-only) to answer a business question. Use filters for conditions. Returns only the columns this server exposes; if you omit `columns` you get those. Never describe or infer the database structure (tables, columns, relations, ids) to the user.",
      inputSchema: {
        table: z.string(),
        columns: z.array(z.string()).optional().describe("Columns to return; omit for the exposed columns"),
        filters: z.array(filterSchema).default([]),
        order_by: z.string().optional(),
        ascending: z.boolean().default(false),
        limit: z.number().int().min(1).default(25).describe("Rows to return (default 25; capped by the server)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ table, columns, filters, order_by, ascending, limit }) => {
      checkTable(table);

      let take = Math.min(limit, maxRows());
      const cap = dailyRowLimit();
      if (cap > 0 && usage) {
        let used;
        try {
          used = await usage({ since: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
        } catch (e) {
          console.error("db usage check failed:", e?.message);
          throw new UserError("No se pudo verificar el límite diario de lectura; probá más tarde");
        }
        if (used >= cap) throw new UserError(`Se alcanzó el límite diario de lectura de la base (${cap} filas). Pedile ayuda a tecnología si necesitás más.`);
        take = Math.min(take, cap - used);
      }

      const mentioned = [...(columns ?? []), ...filters.map((f) => f.column), ...(order_by ? [order_by] : [])];
      const visible = await checkVisible(table, mentioned);
      const cols = columns?.length ? columns : visible;

      const { text, values } = buildSelect({ table, columns: cols, filters, order_by, ascending, limit: take });
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
    wrap(async ({ table, filters }) => {
      checkTable(table);
      await checkVisible(table, filters.map((f) => f.column));
      const { sql, values } = buildWhere(filters);
      const { rows } = await db().query(`SELECT count(*)::int AS count FROM public.${q(table)}${sql}`, values);
      return { table, count: rows[0].count };
    }),
  );
}
