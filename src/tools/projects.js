import { z } from "zod";
import { projectsBase, zohoGet } from "../zoho.js";
import { safe, ID_RE, clip } from "../util.js";

// Read-only view of Zoho Projects (REST v1 portal API, the same one the backends use).

function portalUrl() {
  const portal = process.env.PROJECTS_PORTAL_ID;
  if (!portal) throw new Error("Zoho Projects no configurado: falta PROJECTS_PORTAL_ID");
  return `${projectsBase()}/restapi/portal/${encodeURIComponent(portal)}`;
}

const stripHtml = (s) => (typeof s === "string" ? s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : s);

export const slimProject = (p = {}) => ({
  id: p.id_string,
  name: p.name,
  status: p.status,
  owner: p.owner_name,
  open_tasks: p.task_count?.open,
  closed_tasks: p.task_count?.closed,
  end_date: p.end_date || undefined,
});

export const slimTask = (t = {}) => ({
  id: t.id_string,
  name: t.name,
  status: t.status?.name,
  priority: t.priority,
  tasklist: t.tasklist?.name,
  owners: (t.details?.owners || []).map((o) => o.name).filter(Boolean),
  start_date: t.start_date || undefined,
  end_date: t.end_date || undefined,
  completed: t.completed,
  description: clip(stripHtml(t.description), 500) || undefined,
  link: t.link?.web?.url,
});

export function registerProjects(server) {
  server.registerTool(
    "projects_list_projects",
    {
      description: "List Zoho Projects projects.",
      inputSchema: {
        status: z.enum(["active", "archived", "template"]).default("active"),
        range: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ status, range }) => {
      const r = await zohoGet("projects", `${portalUrl()}/projects/`, { status, range, index: 1 });
      return (r?.projects || []).map(slimProject);
    }),
  );

  server.registerTool(
    "projects_list_tasks",
    {
      description:
        "List tasks of a Zoho Projects project. status: notcompleted (default), completed or all. Use index (starts at 1) to page.",
      inputSchema: {
        project_id: z.string().regex(ID_RE),
        status: z.enum(["notcompleted", "completed", "all"]).default("notcompleted"),
        range: z.number().int().min(1).max(100).default(50),
        index: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project_id, status, range, index }) => {
      const r = await zohoGet("projects", `${portalUrl()}/projects/${project_id}/tasks/`, { status, range, index });
      const tasks = (r?.tasks || []).map(slimTask);
      return { count: tasks.length, next_index: tasks.length === range ? index + range : undefined, tasks };
    }),
  );

  server.registerTool(
    "projects_get_task",
    {
      description: "Get one Zoho Projects task with its comments.",
      inputSchema: { project_id: z.string().regex(ID_RE), task_id: z.string().regex(ID_RE) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ project_id, task_id }) => {
      const base = `${portalUrl()}/projects/${project_id}/tasks/${task_id}/`;
      const [task, comments] = await Promise.all([zohoGet("projects", base), zohoGet("projects", `${base}comments/`)]);
      return {
        ...slimTask(task?.tasks?.[0]),
        comments: (comments?.comments || []).map((c) => ({
          author: c.added_person || c.created_by,
          created: c.created_time || c.created_time_format,
          text: clip(stripHtml(c.content), 600),
        })),
      };
    }),
  );
}
