import { z } from "zod";
import { apiBase, cliqBase, zohoGet, zohoPost } from "../zoho.js";
import { safe, ID_RE } from "../util.js";
import { portalUrl } from "./projects.js";

// Level A write tools (docs/SPEC.md section 4): they only ADD things, never overwrite or
// delete. Registered only when WRITES_ENABLED=true. They use the separate write token
// (Z_WRITE_REFRESH_TOKEN) and the audit wrapper makes them fail-closed.

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const CRM_MODULES = ["Leads", "Contacts", "Deals", "Accounts"];
const crm = () => `${apiBase()}/crm/v2`;
const wd = () => `${apiBase()}/workdrive/api/v1`;
const TEXT_EXT = /\.(txt|md|csv|json|html|log)$/i;
const FILENAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,150}$/;
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,100}$/;

export const cliqWriteChannels = () =>
  (process.env.CLIQ_WRITE_CHANNELS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Footer so everyone can see the text came from Claude and on whose request. */
const signed = (text, user) => `${text}\n\n— enviado desde Claude (IRIS MCP) a pedido de ${user}`;

/** CRM answers 200 with a per-record code; surface failures instead of reporting success. */
function crmResult(r) {
  const item = r?.data?.[0];
  if (!item || item.code !== "SUCCESS") {
    throw new Error(`CRM rechazó la escritura: ${item?.message || item?.code || "respuesta inesperada"}`);
  }
  return { ok: true, id: item.details?.id };
}

const isoToUs = (d) => { const [y, m, day] = d.split("-"); return `${m}-${day}-${y}`; }; // Projects wants MM-DD-YYYY
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "formato AAAA-MM-DD");

export function registerWrites(server, { getUser }) {
  server.registerTool(
    "crm_add_note",
    {
      description: "Add a note to a Zoho CRM lead, contact, deal or account. Only adds; existing notes are never changed.",
      inputSchema: {
        module: z.enum(CRM_MODULES),
        id: z.string().regex(ID_RE),
        title: z.string().max(120).optional(),
        content: z.string().min(1).max(5000),
      },
      annotations: WRITE,
    },
    safe(async ({ module, id, title, content }) =>
      // Generic /Notes endpoint: the nested /{module}/{id}/Notes route is rejected with OAUTH_SCOPE_MISMATCH
      crmResult(await zohoPost("crm_write", `${crm()}/Notes`, {
        json: { data: [{ Note_Title: title, Note_Content: signed(content, getUser()), Parent_Id: id, se_module: module }] },
      })),
    ),
  );

  server.registerTool(
    "crm_create_task",
    {
      description: "Create a task in Zoho CRM, optionally linked to a lead, contact, deal or account.",
      inputSchema: {
        subject: z.string().min(1).max(200),
        due_date: isoDate.optional(),
        description: z.string().max(5000).optional(),
        related_module: z.enum(CRM_MODULES).optional(),
        related_id: z.string().regex(ID_RE).optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ subject, due_date, description, related_module, related_id }) => {
      if (!!related_module !== !!related_id) throw new Error("related_module y related_id van juntos");
      const task = { Subject: subject, Due_Date: due_date, Status: "Not Started" };
      if (description) task.Description = signed(description, getUser());
      if (related_module === "Contacts") task.Who_Id = { id: related_id };
      else if (related_module) Object.assign(task, { What_Id: { id: related_id }, $se_module: related_module });
      return crmResult(await zohoPost("crm_write", `${crm()}/Tasks`, { json: { data: [task] } }));
    }),
  );

  server.registerTool(
    "projects_create_task",
    {
      description: "Create a task in a Zoho Projects project.",
      inputSchema: {
        project_id: z.string().regex(ID_RE),
        name: z.string().min(1).max(200),
        description: z.string().max(5000).optional(),
        due_date: isoDate.optional(),
        tasklist_id: z.string().regex(ID_RE).optional(),
      },
      annotations: WRITE,
    },
    safe(async ({ project_id, name, description, due_date, tasklist_id }) => {
      const form = { name };
      if (description) form.description = signed(description, getUser());
      if (due_date) form.end_date = isoToUs(due_date);
      if (tasklist_id) form.tasklist_id = tasklist_id;
      const r = await zohoPost("projects_write", `${portalUrl()}/projects/${project_id}/tasks/`, { form });
      const t = r?.tasks?.[0];
      if (!t) throw new Error("Projects no devolvió la tarea creada");
      return { ok: true, id: t.id_string, link: t.link?.web?.url };
    }),
  );

  server.registerTool(
    "projects_add_comment",
    {
      description: "Add a comment to a Zoho Projects task. Only adds; existing comments are never changed.",
      inputSchema: {
        project_id: z.string().regex(ID_RE),
        task_id: z.string().regex(ID_RE),
        content: z.string().min(1).max(5000),
      },
      annotations: WRITE,
    },
    safe(async ({ project_id, task_id, content }) => {
      await zohoPost("projects_write", `${portalUrl()}/projects/${project_id}/tasks/${task_id}/comments/`, {
        form: { content: signed(content, getUser()) },
      });
      return { ok: true };
    }),
  );

  server.registerTool(
    "cliq_post_message",
    {
      description:
        "Post a message to a Zoho Cliq channel. Only channels in the server's allowed list (CLIQ_WRITE_CHANNELS) can be used; use the channel's unique name.",
      inputSchema: {
        channel: z.string().regex(CHANNEL_RE).describe("Channel unique name, e.g. tech-team"),
        text: z.string().min(1).max(4000),
      },
      annotations: WRITE,
    },
    safe(async ({ channel, text }) => {
      const allowed = cliqWriteChannels();
      if (!allowed.length) throw new Error("No hay canales de Cliq habilitados para publicar (CLIQ_WRITE_CHANNELS)");
      if (!allowed.includes(channel.toLowerCase())) {
        throw new Error(`Canal no permitido: ${channel}. Permitidos: ${allowed.join(", ")}`);
      }
      await zohoPost("cliq_write", `${cliqBase()}/api/v2/channelsbyname/${channel.toLowerCase()}/message`, {
        json: { text: signed(text, getUser()) },
      });
      return { ok: true };
    }),
  );

  server.registerTool(
    "workdrive_upload_file",
    {
      description:
        "Upload a NEW text file (txt, md, csv, json, html, log) to an existing WorkDrive folder. Refuses if a file with that name already exists; it never overwrites.",
      inputSchema: {
        folder_id: z.string().regex(ID_RE),
        filename: z.string().regex(FILENAME_RE),
        content: z.string().min(1).max(200_000),
      },
      annotations: WRITE,
    },
    safe(async ({ folder_id, filename, content }) => {
      if (!TEXT_EXT.test(filename)) throw new Error("Solo se pueden subir archivos de texto: .txt .md .csv .json .html .log");
      const existing = await zohoGet("workdrive", `${wd()}/files/${folder_id}/files`, { "page[limit]": 200 });
      const clash = (existing?.data || []).some((f) => String(f.attributes?.name || "").toLowerCase() === filename.toLowerCase());
      if (clash) throw new Error(`Ya existe un archivo llamado "${filename}" en esa carpeta; no se sobrescribe`);
      const form = new FormData();
      form.set("parent_id", folder_id);
      form.set("override-name-exist", "false");
      form.set("content", new Blob([content], { type: "text/plain" }), filename);
      const r = await zohoPost("workdrive_write", `${wd()}/upload`, { multipart: form });
      const f = r?.data?.[0];
      if (!f) throw new Error("WorkDrive no devolvió el archivo subido");
      return { ok: true, id: f.attributes?.resource_id || f.id, name: f.attributes?.FileName || filename };
    }),
  );
}
