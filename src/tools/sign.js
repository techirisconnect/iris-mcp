import { z } from "zod";
import { signBase, zohoGet } from "../zoho.js";
import { safe, ID_RE, clip } from "../util.js";

// Read-only view of Zoho Sign. Sending, recalling or reminding is out of scope (spec level C).

const SCAN_PAGE = 100;
const MAX_SCAN = 500;

const iso = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
};

export function slimSignRequest(raw = {}) {
  return {
    request_id: raw.request_id,
    name: raw.request_name,
    status: String(raw.request_status || raw.status || "").toLowerCase(),
    owner: [raw.owner_first_name, raw.owner_last_name].filter(Boolean).join(" ") || raw.owner_email || undefined,
    created: iso(raw.created_time),
    modified: iso(raw.modified_time),
    expires: iso(raw.expire_by),
    description: clip(raw.description, 300) || undefined,
    signers: (raw.actions || []).map((a) => ({
      name: a.recipient_name,
      email: a.recipient_email,
      role: a.action_type,
      status: a.action_status,
    })),
  };
}

async function fetchPage(startIndex) {
  const data = JSON.stringify({
    page_context: { row_count: SCAN_PAGE, start_index: startIndex, sort_column: "created_time", sort_order: "DESC" },
  });
  const r = await zohoGet("sign", `${signBase()}/requests`, { data });
  if (r?.status !== "success") throw new Error(`Zoho Sign: ${r?.message || "respuesta inesperada"}`);
  return { rows: r.requests || [], hasMore: !!r.page_context?.has_more_rows };
}

export function registerSign(server) {
  server.registerTool(
    "sign_list_requests",
    {
      description:
        "List Zoho Sign documents (newest first), e.g. leases pending signature. Filter by status (inprogress, completed, declined, expired, recalled, draft) and/or text in the name.",
      inputSchema: {
        status: z.string().optional(),
        search: z.string().optional().describe("Case-insensitive text in the document name"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ status, search, limit }) => {
      // Sign's API rejects status filters, so the filtering happens here.
      const out = [];
      let start = 1;
      let scanned = 0;
      let truncated = false;
      while (out.length < limit) {
        const { rows, hasMore } = await fetchPage(start);
        scanned += rows.length;
        start += rows.length;
        for (const row of rows) {
          const s = slimSignRequest(row);
          if (status && s.status !== status.toLowerCase()) continue;
          if (search && !String(s.name || "").toLowerCase().includes(search.toLowerCase())) continue;
          out.push(s);
          if (out.length >= limit) break;
        }
        if (!hasMore || rows.length === 0) break;
        if (scanned >= MAX_SCAN) {
          truncated = true;
          break;
        }
      }
      return { count: out.length, truncated: truncated || undefined, requests: out };
    }),
  );

  server.registerTool(
    "sign_get_request",
    {
      description: "Get one Zoho Sign document with the status of each signer.",
      inputSchema: { request_id: z.string().regex(ID_RE) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ request_id }) => {
      const r = await zohoGet("sign", `${signBase()}/requests/${request_id}`);
      if (r?.status !== "success") throw new Error(`Zoho Sign: ${r?.message || "respuesta inesperada"}`);
      return slimSignRequest(r.requests);
    }),
  );
}
