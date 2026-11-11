// Shared helpers for tool results.

export const ok = (data) => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

export const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${err?.message || err}` }],
});

/** Wrap a handler so thrown errors become MCP tool errors instead of crashing. */
export const safe = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

// CRM module API names are interpolated into URLs: restrict them.
export const MODULE_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isEmpty = (v) =>
  v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/** CRM record without Zoho internals ($-fields) and without empty values. */
export function slimCrmRecord(rec) {
  return Object.fromEntries(
    Object.entries(rec).filter(([k, v]) => !k.startsWith("$") && !isEmpty(v)),
  );
}

export function slimCrmResponse(r) {
  if (!r || !Array.isArray(r.data)) return r;
  return {
    data: r.data.map(slimCrmRecord),
    ...(r.info && { info: { page: r.info.page, per_page: r.info.per_page, count: r.info.count, more_records: r.info.more_records } }),
  };
}

export const clip = (s, n = 600) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
