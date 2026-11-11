import { z } from "zod";
import { apiBase, zohoGet } from "../zoho.js";
import { safe, MODULE_RE, ID_RE, slimCrmResponse } from "../util.js";

const crm = () => `${apiBase()}/crm/v2`;
const moduleName = z.string().regex(MODULE_RE).describe("CRM module API name, e.g. Leads, Contacts, Deals, Accounts");

export function registerCrm(server) {
  server.registerTool(
    "crm_search_records",
    {
      description:
        "Search Zoho CRM records in a module. Provide exactly one of: word (free text), email, phone, or criteria (e.g. (Last_Name:equals:Smith)).",
      inputSchema: {
        module: moduleName,
        word: z.string().min(2).optional().describe("Free text, at least 2 letters"),
        email: z.string().optional(),
        phone: z.string().optional(),
        criteria: z.string().optional(),
        per_page: z.number().int().min(1).max(200).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ module, word, email, phone, criteria, per_page, page }) => {
      const given = [word, email, phone, criteria].filter(Boolean);
      if (given.length !== 1) throw new Error("Indicá exactamente uno de: word, email, phone, criteria");
      return slimCrmResponse(await zohoGet("crm", `${crm()}/${module}/search`, { word, email, phone, criteria, per_page, page }));
    }),
  );

  server.registerTool(
    "crm_get_record",
    {
      description: "Get one Zoho CRM record by id.",
      inputSchema: { module: moduleName, id: z.string().regex(ID_RE) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ module, id }) => slimCrmResponse(await zohoGet("crm", `${crm()}/${module}/${id}`))),
  );

  server.registerTool(
    "crm_list_records",
    {
      description:
        "List records of a Zoho CRM module. Zoho requires an explicit field list (comma separated API names).",
      inputSchema: {
        module: moduleName,
        fields: z.string().min(1).describe("e.g. Full_Name,Email,Phone,Lead_Status"),
        sort_by: z.string().optional().describe("Modified_Time or Created_Time"),
        sort_order: z.enum(["asc", "desc"]).default("desc"),
        per_page: z.number().int().min(1).max(200).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ module, fields, sort_by, sort_order, per_page, page }) =>
      slimCrmResponse(await zohoGet("crm", `${crm()}/${module}`, { fields, sort_by, sort_order, per_page, page })),
    ),
  );

  server.registerTool(
    "crm_list_modules",
    { description: "List the Zoho CRM modules available (API names).", inputSchema: {}, annotations: { readOnlyHint: true } },
    safe(async () => {
      const r = await zohoGet("crm", `${crm()}/settings/modules`);
      return (r?.modules || []).map((m) => ({ api_name: m.api_name, label: m.plural_label }));
    }),
  );
}
