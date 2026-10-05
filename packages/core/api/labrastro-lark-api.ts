// Labrastro fork API. Public methods are mounted by labrastro-api.ts.
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods, parseConfirmedWrite, parseRequiredResponse } from "./labrastro-api-helpers";
import { LarkConversationResponseSchema, LarkTargetCapabilitiesSchema, LarkChatsPageSchema, LarkAnchorsPageSchema, LarkPrivateChatCandidatesSchema, type LarkTargetCapabilities, type LarkChatsPage, type LarkAnchorsPage, type LarkConversationGrant, type LarkPrivateChatCandidateList } from "../lark/schema";

const labrastroLarkApi = {
  async setLarkConversation(this: ApiClient, workspaceId: string, installationId: string, chats: { chat_id: string; chat_type: "group" | "p2p" }[]): Promise<void> {
    const raw = await clientFetch<unknown>(this, `/api/workspaces/${workspaceId}/lark/installations/${installationId}/conversation`, {
      method: "PUT", body: JSON.stringify({ scope: "workspace", chats }),
    });
    parseConfirmedWrite(raw, LarkConversationResponseSchema, "setLarkConversation");
  },

  // Lark target discovery (OL-72 contract): read-only group / message-anchor
  // listing behind the group, topic and conversation-grant pickers. Every
  // response passes a schema before returning — a malformed page is thrown as
  // an error so the picker shows its failure state instead of merging
  // unverified rows. `cursor` is the opaque signed continuation from the
  // previous page; it is forwarded unchanged, never constructed here.

  async getLarkTargetCapabilities(
    this: ApiClient,
    workspaceId: string,
    installationId: string,
  ): Promise<LarkTargetCapabilities> {
    const raw = await clientFetch<unknown>(this,
      `/api/workspaces/${workspaceId}/lark/installations/${installationId}/target-capabilities`,
    );
    return parseRequiredResponse(raw, LarkTargetCapabilitiesSchema, "getLarkTargetCapabilities");
  },

  async listLarkTargetChats(
    this: ApiClient,
    workspaceId: string,
    installationId: string,
    opts: { pageSize?: number; q?: string; cursor?: string } = {},
  ): Promise<LarkChatsPage> {
    const search = new URLSearchParams();
    if (opts.pageSize != null) search.set("page_size", String(opts.pageSize));
    if (opts.q) search.set("q", opts.q);
    if (opts.cursor) search.set("cursor", opts.cursor);
    const qs = search.toString();
    const raw = await clientFetch<unknown>(this,
      `/api/workspaces/${workspaceId}/lark/installations/${installationId}/chats${qs ? `?${qs}` : ""}`,
    );
    return parseRequiredResponse(raw, LarkChatsPageSchema, "listLarkTargetChats");
  },

  async listLarkMessageAnchors(
    this: ApiClient,
    workspaceId: string,
    installationId: string,
    chatId: string,
    opts: { pageSize?: number; cursor?: string } = {},
  ): Promise<LarkAnchorsPage> {
    const search = new URLSearchParams();
    if (opts.pageSize != null) search.set("page_size", String(opts.pageSize));
    if (opts.cursor) search.set("cursor", opts.cursor);
    const qs = search.toString();
    const raw = await clientFetch<unknown>(this,
      `/api/workspaces/${workspaceId}/lark/installations/${installationId}/chats/${encodeURIComponent(chatId)}/message-anchors${qs ? `?${qs}` : ""}`,
    );
    return parseRequiredResponse(raw, LarkAnchorsPageSchema, "listLarkMessageAnchors");
  },

  // Lark private chat discovery (OL-75 contract): observed private chats a
  // human can authorize. The list is read-only — it never sends messages or
  // changes consent; confirmation appends the selected candidates to the
  // saved grant atomically server-side and returns the resulting full grant,
  // which callers must treat as the authoritative saved state.

  async listLarkPrivateChatCandidates(
    this: ApiClient,
    workspaceId: string,
    installationId: string,
  ): Promise<LarkPrivateChatCandidateList> {
    const raw = await clientFetch<unknown>(this,
      `/api/workspaces/${workspaceId}/lark/installations/${installationId}/private-chat-candidates`,
    );
    return parseRequiredResponse(raw, LarkPrivateChatCandidatesSchema, "listLarkPrivateChatCandidates");
  },

  async confirmLarkPrivateChatCandidates(
    this: ApiClient,
    workspaceId: string,
    installationId: string,
    candidateIds: string[],
  ): Promise<LarkConversationGrant | null> {
    const raw = await clientFetch<unknown>(this,
      `/api/workspaces/${workspaceId}/lark/installations/${installationId}/private-chat-candidates/confirm`,
      { method: "POST", body: JSON.stringify({ scope: "workspace", candidate_ids: candidateIds }) },
    );
    const parsed = parseConfirmedWrite(raw, LarkConversationResponseSchema, "confirmLarkPrivateChatCandidates");
    return parsed.conversation;
  },
};

export type LabrastroLarkApi = typeof labrastroLarkApi;

export function installLabrastroLarkApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroLarkApi);
}
