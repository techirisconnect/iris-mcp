import crypto from "node:crypto";

// Two-step confirmation for Level B writes (docs/SPEC.md section 4). A "propose" tool reads
// the current state and returns the exact change plus a signed token; the matching "apply"
// tool refuses to run without a valid token. The token binds user, tool, arguments and the
// values seen at proposal time, so the change that is applied is the one that was shown.
// Stateless on purpose: the remote server builds a new McpServer per request.

const TTL_MS = 10 * 60 * 1000;

const secret = () => {
  const s = process.env.CONFIRM_SECRET || process.env.ZOHO_LOGIN_CLIENT_SECRET || process.env.Z_CLIENT_SECRET;
  if (!s) throw new Error("Falta CONFIRM_SECRET para firmar las confirmaciones");
  return s;
};

const mac = (body) => crypto.createHmac("sha256", secret()).update(body).digest("base64url");

/** Stable JSON (sorted keys) so the same data always signs the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function signConfirmation({ user, tool, args, snapshot }) {
  const body = Buffer.from(canonical({ user, tool, args, snapshot, exp: Date.now() + TTL_MS })).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** Returns the snapshot stored at proposal time, or throws. */
export function verifyConfirmation(token, { user, tool, args }) {
  const [body, sig] = String(token || "").split(".");
  const ok = body && sig && sig.length === mac(body).length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac(body)));
  if (!ok) throw new Error("Confirmación inválida: primero hay que proponer el cambio y mostrarlo a la persona");
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (p.exp < Date.now()) throw new Error("La confirmación venció (10 min); proponé el cambio de nuevo");
  if (p.user !== user || p.tool !== tool || canonical(p.args) !== canonical(args)) {
    throw new Error("La confirmación no corresponde a este cambio; proponelo de nuevo");
  }
  return p.snapshot;
}
