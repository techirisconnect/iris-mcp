// Zoho OAuth + HTTP helper (native fetch, no axios). Each product uses its own
// refresh token because the scopes differ (CRM, Cliq, WorkDrive).

const accountsBase = () => process.env.Z_ACCOUNTS_BASE || "https://accounts.zohocloud.ca";
export const apiBase = () => process.env.Z_API_BASE || "https://www.zohoapis.ca";
export const cliqBase = () => process.env.CLIQ_BASE_URL || "https://cliq.zohocloud.ca";
export const signBase = () => process.env.SIGN_API_BASE || "https://sign.zohocloud.ca/api/v1";
export const projectsBase = () => process.env.PROJECTS_API_BASE || "https://projectsapi.zohocloud.ca";

const cache = new Map(); // product -> { token, expiresAt }

const REFRESH_ENV = {
  crm: ["Z_REFRESH_TOKEN"],
  cliq: ["CLIQ_OAUTH_REFRESH_TOKEN"],
  workdrive: ["Z_WORKDRIVE_REFRESH_TOKEN"],
  // Sign and Projects fall back to the combined read-only token (Z_REFRESH_TOKEN)
  // when it was generated with their scopes too.
  sign: ["Z_SIGN_REFRESH_TOKEN", "Z_REFRESH_TOKEN"],
  projects: ["PROJECTS_REFRESH_TOKEN", "Z_REFRESH_TOKEN"],
};

function credentials(product) {
  const refresh = REFRESH_ENV[product].map((k) => process.env[k]).find(Boolean);
  const id = (product === "cliq" && process.env.CLIQ_OAUTH_CLIENT_ID) || process.env.Z_CLIENT_ID;
  const secret =
    (product === "cliq" && process.env.CLIQ_OAUTH_CLIENT_SECRET) || process.env.Z_CLIENT_SECRET;
  if (!refresh || !id || !secret) {
    throw new Error(
      `Zoho ${product} no configurado: faltan Z_CLIENT_ID, Z_CLIENT_SECRET y ${REFRESH_ENV[product].join(" / ")}`,
    );
  }
  return { refresh, id, secret };
}

export async function getAccessToken(product) {
  const hit = cache.get(product);
  if (hit && Date.now() < hit.expiresAt - 30_000) return hit.token;

  const { refresh, id, secret } = credentials(product);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: id,
    client_secret: secret,
    refresh_token: refresh,
  });
  const res = await fetch(`${accountsBase()}/oauth/v2/token`, { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  // Zoho answers 200 with { error } when the refresh token is bad.
  if (!data.access_token) {
    throw new Error(`Zoho ${product}: no se pudo renovar el token (${data.error || res.status})`);
  }
  cache.set(product, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

/** GET against a Zoho API. Returns parsed JSON (or null for 204). */
export async function zohoGet(product, url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  const token = await getAccessToken(product);
  const res = await fetch(u, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho ${product} ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function zohoGetBinary(product, url) {
  const token = await getAccessToken(product);
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  if (!res.ok) throw new Error(`Zoho ${product} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") || "" };
}
