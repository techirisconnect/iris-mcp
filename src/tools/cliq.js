import { z } from "zod";
import { cliqBase, zohoGet } from "../zoho.js";
import { safe, ID_RE, clip } from "../util.js";

const base = () => `${cliqBase()}/api/v2`;

export function registerCliq(server) {
  server.registerTool(
    "cliq_list_channels",
    {
      description:
        "List Zoho Cliq channels with their last message. If the result has next_token, pass it back to get the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        next_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ limit, next_token }) => {
      const r = await zohoGet("cliq", `${base()}/channels`, { limit, next_token });
      return {
        channels: (r?.channels || []).map((c) => ({
          name: c.name,
          channel_id: c.channel_id,
          chat_id: c.chat_id,
          description: c.description || undefined,
          participants: c.participant_count,
          total_messages: c.total_message_count,
          last_message: c.last_message_info && {
            time: c.last_message_info.time,
            sender: c.last_message_info.sender_name,
            text: clip(c.last_message_info.text, 300),
          },
        })),
        has_more: !!r?.has_more,
        next_token: r?.has_more ? r.next_token : undefined,
      };
    }),
  );

  server.registerTool(
    "cliq_list_channel_members",
    {
      description: "List members of a Cliq channel by channel id.",
      inputSchema: { channel_id: z.string().regex(ID_RE) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ channel_id }) => {
      const r = await zohoGet("cliq", `${base()}/channels/${channel_id}/members`);
      return (r?.members || []).map((m) => ({ name: m.name, email: m.email_id, role: m.user_role, user_id: m.user_id }));
    }),
  );

  server.registerTool(
    "cliq_get_messages",
    {
      description:
        "Read recent messages of a Cliq chat (newest first as returned by Zoho). Use the chat_id of the channel (cliq_list_channels returns it). Needs the ZohoCliq.Messages.READ scope.",
      inputSchema: {
        chat_id: z.string().regex(ID_RE),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ chat_id, limit }) => {
      const r = await zohoGet("cliq", `${base()}/chats/${chat_id}/messages`, { limit });
      return (r?.data || []).map((m) => ({
        time: m.time ? new Date(Number(m.time)).toISOString() : undefined,
        sender: m.sender?.name,
        type: m.type,
        text: clip(typeof m.content === "string" ? m.content : m.content?.text, 800),
        id: m.id,
      }));
    }),
  );
}
