import { z } from "zod";
import { apiBase, zohoGet, zohoPost, zohoPut } from "../zoho.js";
import { safe, ID_RE } from "../util.js";
import { portalUrl } from "./projects.js";
import { signConfirmation, verifyConfirmation, canonical } from "../confirm.js";

// Level B write tools (docs/SPEC.md section 4): they change or create data, so each one is a
// pair. A "propose" tool (read-only) shows the exact change with the current values and
// returns a signed token; the "apply" tool refuses to run without it, re-reads the record to
// make sure nothing changed in between, stores the old and new values in the audit log
// BEFORE acting (fail-closed) and only then writes. There is still no delete anywhere.
// Registered only when WRITES_B_ENABLED=true; uses the separate token Z_WRITE_B_REFRESH_TOKEN.

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const MODULES = ["Leads", "Contacts"];
const crm = () => `${apiBase()}/crm/v2`;

// Fields Claude may change. Override per module with CRM_UPDATE_FIELDS_LEADS / _CONTACTS.
const DEFAULT_UPDATE_FIELDS = {
  Leads: ["Notes_Description", "Owner_Inquiry_Notes", "Arrival_Date", "movein_date"],
  Contacts: ["Notes_Description", "Comments", "Timeline_for_Moving"],
};
export const updateFields = (module) => {
  const env = process.env[`CRM_UPDATE_FIELDS_${module.toUpperCase()}`];
  return env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_UPDATE_FIELDS[module];
};
const CREATE_FIELDS = ["First_Name", "Last_Name", "Email", "Phone", "Notes_Description"];

const value = z.string().max(2000);

function crmResult(r) {
  const item = r?.data?.[0];
  if (!item || item.code !== "SUCCESS") {
    throw new Error(`CRM rechazó la escritura: ${item?.message || item?.code || "respuesta inesperada"}`);
  }
  return { ok: true, id: item.details?.id };
}

const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);

async function readCrm(module, id, fields) {
  const r = await zohoGet("crm", `${crm()}/${module}/${id}`, { fields: fields.join(",") });
  const rec = r?.data?.[0];
  if (!rec) throw new Error("No se encontró el registro");
  return Object.fromEntries(fields.map((f) => [f, rec[f] ?? null]));
}

/** Existing leads/contacts with the same email or phone (read token). */
async function findDuplicates(module, { Email, Phone }) {
  const found = new Map();
  for (const [param, v] of [["email", Email], ["phone", Phone]]) {
    if (!v) continue;
    const r = await zohoGet("crm", `${crm()}/${module}/search`, { [param]: v });
    for (const d of r?.data || []) found.set(d.id, { id: d.id, name: d.Full_Name || d.Last_Name, email: d.Email, phone: d.Phone });
  }
  return [...found.values()];
}

const taskOf = (r) => r?.tasks?.[0];
const taskState = (t) => ({
  status_id: String(t?.status?.id ?? t?.custom_status ?? ""),
  status: t?.status?.name ?? null,
  owners: (t?.details?.owners || []).map((o) => ({ id: o.id ? String(o.id) : null, name: o.name })), // "Unassigned" has no id
});
async function readTask(project_id, task_id) {
  const t = taskOf(await zohoGet("projects", `${portalUrl()}/projects/${project_id}/tasks/${task_id}/`));
  if (!t) throw new Error("No se encontró la tarea");
  return t;
}

const PROPOSAL_HINT = "Mostrale a la persona exactamente estos cambios (actual → nuevo) y aplicá solo si los aprueba, con el mismo confirmation_token.";

export function registerWritesB(server, { getUser, record }) {
  // ---- CRM: update fields ----
  server.registerTool(
    "crm_propose_update",
    {
      description: `Step 1 of 2. Show the exact change to a lead or contact (current → new value) without applying it. Only these fields can be changed: Leads ${updateFields("Leads").join(", ")}; Contacts ${updateFields("Contacts").join(", ")}.`,
      inputSchema: { module: z.enum(MODULES), id: z.string().regex(ID_RE), changes: z.record(z.string(), value) },
      annotations: READ,
    },
    safe(async ({ module, id, changes }) => {
      const allowed = updateFields(module);
      const fields = Object.keys(changes);
      if (!fields.length) throw new Error("No hay cambios");
      const bad = fields.filter((f) => !allowed.includes(f));
      if (bad.length) throw new Error(`Campos no permitidos: ${bad.join(", ")}. Permitidos: ${allowed.join(", ")}`);
      const current = await readCrm(module, id, fields);
      return {
        module, id,
        changes: fields.map((f) => ({ field: f, current: current[f], new: changes[f] })),
        confirmation_token: signConfirmation({ user: getUser(), tool: "crm_apply_update", args: { module, id, changes }, snapshot: current }),
        next: PROPOSAL_HINT,
      };
    }),
  );

  server.registerTool(
    "crm_apply_update",
    {
      description: "Step 2 of 2. Apply a change shown by crm_propose_update, only after the person approved it. Needs its confirmation_token; fails if the record changed since the proposal.",
      inputSchema: { module: z.enum(MODULES), id: z.string().regex(ID_RE), changes: z.record(z.string(), value), confirmation_token: z.string().max(8000) },
      annotations: WRITE,
    },
    safe(async ({ module, id, changes, confirmation_token }) => {
      const snapshot = verifyConfirmation(confirmation_token, { user: getUser(), tool: "crm_apply_update", args: { module, id, changes } });
      const allowed = updateFields(module);
      const fields = Object.keys(changes);
      if (fields.some((f) => !allowed.includes(f))) throw new Error("Campos no permitidos");
      const current = await readCrm(module, id, fields);
      if (!same(current, snapshot)) throw new Error("El registro cambió desde la propuesta; proponé el cambio de nuevo");
      await record({ tool: "crm_apply_update", system: "crm", phase: "before", outcome: "attempt", params: { module, id, old: current, new: changes } });
      return crmResult(await zohoPut("crm_b", `${crm()}/${module}/${id}`, { json: { data: [changes] } }));
    }),
  );

  // ---- CRM: create lead/contact ----
  server.registerTool(
    "crm_propose_create",
    {
      description: `Step 1 of 2. Check for duplicates and show the lead or contact that would be created, without creating it. Allowed fields: ${CREATE_FIELDS.join(", ")} (Last_Name is required). If a lead/contact with the same email or phone exists, no token is returned.`,
      inputSchema: { module: z.enum(MODULES), fields: z.record(z.string(), value) },
      annotations: READ,
    },
    safe(async ({ module, fields }) => {
      const bad = Object.keys(fields).filter((f) => !CREATE_FIELDS.includes(f));
      if (bad.length) throw new Error(`Campos no permitidos: ${bad.join(", ")}. Permitidos: ${CREATE_FIELDS.join(", ")}`);
      if (!fields.Last_Name) throw new Error("Last_Name es obligatorio");
      if (!fields.Email && !fields.Phone) throw new Error("Hace falta Email o Phone para poder buscar duplicados");
      const duplicates = await findDuplicates(module, fields);
      if (duplicates.length) return { module, would_create: fields, duplicates, next: "Ya existe. No se crea; usá el registro existente." };
      return {
        module, would_create: fields, duplicates: [],
        confirmation_token: signConfirmation({ user: getUser(), tool: "crm_apply_create", args: { module, fields }, snapshot: { duplicates: 0 } }),
        next: PROPOSAL_HINT,
      };
    }),
  );

  server.registerTool(
    "crm_apply_create",
    {
      description: "Step 2 of 2. Create the lead or contact shown by crm_propose_create, only after the person approved it. Checks duplicates again.",
      inputSchema: { module: z.enum(MODULES), fields: z.record(z.string(), value), confirmation_token: z.string().max(8000) },
      annotations: WRITE,
    },
    safe(async ({ module, fields, confirmation_token }) => {
      verifyConfirmation(confirmation_token, { user: getUser(), tool: "crm_apply_create", args: { module, fields } });
      if (Object.keys(fields).some((f) => !CREATE_FIELDS.includes(f))) throw new Error("Campos no permitidos");
      if ((await findDuplicates(module, fields)).length) throw new Error("Ya existe un registro con ese email o teléfono; no se crea");
      await record({ tool: "crm_apply_create", system: "crm", phase: "before", outcome: "attempt", params: { module, new: fields } });
      return crmResult(await zohoPost("crm_b", `${crm()}/${module}`, { json: { data: [fields] } }));
    }),
  );

  // ---- Projects: task status / owner ----
  const taskChange = {
    project_id: z.string().regex(ID_RE),
    task_id: z.string().regex(ID_RE),
    status_id: z.string().regex(ID_RE).optional().describe("New status id (see the status of other tasks in the project)"),
    owner_id: z.string().regex(ID_RE).optional().describe("User id of the new person responsible"),
  };

  server.registerTool(
    "projects_propose_task_change",
    {
      description: "Step 1 of 2. Show the change of status and/or responsible person of a Zoho Projects task (current → new) without applying it. Standard status ids: Open 18306000000000356, In Progress 18306000000000362, Closed 18306000000000359. Owner ids can be read from the owners of existing tasks (projects_get_task).",
      inputSchema: taskChange,
      annotations: READ,
    },
    safe(async (args) => {
      const { project_id, task_id, status_id, owner_id } = args;
      if (!status_id && !owner_id) throw new Error("Indicá status_id y/o owner_id");
      const current = taskState(await readTask(project_id, task_id));
      return {
        project_id, task_id, current,
        new: { status_id: status_id ?? null, owner_id: owner_id ?? null },
        confirmation_token: signConfirmation({ user: getUser(), tool: "projects_apply_task_change", args, snapshot: current }),
        next: PROPOSAL_HINT,
      };
    }),
  );

  server.registerTool(
    "projects_apply_task_change",
    {
      description: "Step 2 of 2. Apply the status/owner change shown by projects_propose_task_change, only after the person approved it. Fails if the task changed since the proposal.",
      inputSchema: { ...taskChange, confirmation_token: z.string().max(8000) },
      annotations: WRITE,
    },
    safe(async ({ confirmation_token, ...args }) => {
      const snapshot = verifyConfirmation(confirmation_token, { user: getUser(), tool: "projects_apply_task_change", args });
      const { project_id, task_id, status_id, owner_id } = args;
      const current = taskState(await readTask(project_id, task_id));
      if (!same(current, snapshot)) throw new Error("La tarea cambió desde la propuesta; proponé el cambio de nuevo");
      await record({ tool: "projects_apply_task_change", system: "projects", phase: "before", outcome: "attempt", params: { project_id, task_id, old: current, new: { status_id, owner_id } } });
      const form = {};
      if (status_id) form.custom_status = status_id;
      if (owner_id) form.person_responsible = owner_id;
      await zohoPost("projects_b", `${portalUrl()}/projects/${project_id}/tasks/${task_id}/`, { form });
      return { ok: true };
    }),
  );
}
