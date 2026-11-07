// Labrastro fork API. Public methods are mounted by labrastro-api.ts.
import type { ApiClient } from "./client";
import { clientFetch, installLabrastroApiMethods, parseRequiredResponse } from "./labrastro-api-helpers";
import { LarkTargetCapabilitiesSchema, LarkChatsPageSchema, LarkAnchorsPageSchema, type LarkTargetCapabilities, type LarkChatsPage, type LarkAnchorsPage } from "../lark/schema";

const labrastroLarkApi = {
  // Lark target discovery (OL-72 contract): read-only group / message-anchor
  // listing behind the group and topic pickers. Every response passes a
  // schema before returning — a malformed page is thrown as an error so the
  // picker shows its failure state instead of merging unverified rows. `cursor` is the opaque signed continuation from the
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
};

export type LabrastroLarkApi = typeof labrastroLarkApi;

export function installLabrastroLarkApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroLarkApi);
}
