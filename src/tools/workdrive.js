import { z } from "zod";
import { apiBase, zohoGet, zohoGetBinary } from "../zoho.js";
import { safe, ID_RE } from "../util.js";

const wd = () => `${apiBase()}/workdrive/api/v1`;
// Downloads go through the API host (the separate download.zoho* host rejects our token's scope).
const downloadBase = () => `${wd()}/download`;

const MAX_TEXT_BYTES = 200_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv))/;

let teamId = null;
async function getTeamId() {
  if (process.env.WORKDRIVE_TEAM_ID) return process.env.WORKDRIVE_TEAM_ID;
  if (teamId) return teamId;
  const me = await zohoGet("workdrive", `${wd()}/users/me`);
  const zuid = me?.data?.id;
  const teams = await zohoGet("workdrive", `${wd()}/users/${zuid}/teams`);
  teamId = teams?.data?.[0]?.id;
  if (!teamId) throw new Error("No se pudo determinar el team de WorkDrive; definí WORKDRIVE_TEAM_ID");
  return teamId;
}

const slim = (f) => ({
  id: f.id,
  name: f.attributes?.name,
  type: f.attributes?.type,
  extension: f.attributes?.extn,
  size: f.attributes?.storage_info?.size,
  modified: f.attributes?.modified_time,
  parent_id: f.attributes?.parent_id,
  permalink: f.attributes?.permalink,
});

export function registerWorkDrive(server) {
  server.registerTool(
    "workdrive_search",
    {
      description: "Search WorkDrive files and folders by name/content keyword.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ query, limit }) => {
      const team = await getTeamId();
      const r = await zohoGet("workdrive", `${wd()}/teams/${team}/records`, {
        "search[all]": query,
        "page[limit]": limit,
      });
      return (r?.data || []).map(slim);
    }),
  );

  server.registerTool(
    "workdrive_list_folder",
    {
      description: "List the files and subfolders inside a WorkDrive folder id.",
      inputSchema: { folder_id: z.string().regex(ID_RE), limit: z.number().int().min(1).max(50).default(50) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ folder_id, limit }) => {
      const r = await zohoGet("workdrive", `${wd()}/files/${folder_id}/files`, { "page[limit]": limit });
      return (r?.data || []).map(slim);
    }),
  );

  server.registerTool(
    "workdrive_get_file_info",
    {
      description: "Get metadata of a WorkDrive file or folder.",
      inputSchema: { file_id: z.string().regex(ID_RE) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ file_id }) => slim((await zohoGet("workdrive", `${wd()}/files/${file_id}`)).data)),
  );

  server.registerTool(
    "workdrive_read_file",
    {
      description: `Download a WorkDrive file and return its text (text/json/csv/xml only, max ${MAX_TEXT_BYTES} bytes). For other formats use workdrive_get_file_info and share the permalink.`,
      inputSchema: { file_id: z.string().regex(ID_RE) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ file_id }) => {
      const { buffer, type } = await zohoGetBinary("workdrive", `${downloadBase()}/${file_id}`);
      if (!TEXT_TYPES.test(type)) {
        return `Archivo no textual (${type || "tipo desconocido"}, ${buffer.length} bytes). Usá workdrive_get_file_info para el enlace.`;
      }
      const text = buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8");
      return buffer.length > MAX_TEXT_BYTES ? `${text}\n[truncado: ${buffer.length} bytes en total]` : text;
    }),
  );
}
