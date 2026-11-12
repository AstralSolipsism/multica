import { z } from "zod";
import type { ApiClient } from "./client";
import { clientFetch } from "./labrastro-api-helpers";
import { parseWithFallback } from "./schema";
import { WikiThreadSchema, WikiCommentWriteSchema, type WikiThread, wikiCommentAnchorToWire, type WikiCommentAnchor } from "./labrastro-baseline-comment-schemas";

const path = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/baseline`;
const headers = (wsId: string) => ({ "X-Workspace-ID": wsId, "X-Workspace-Slug": "" });

export const labrastroBaselineCommentApi = {
  async getProjectWikiThreads(this: ApiClient, wsId: string, projectId: string, page: string, state = "all") {
    const endpoint = `${path(projectId)}/pages/${encodeURIComponent(page)}/threads?state=${encodeURIComponent(state)}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(wsId) });
    return parseWithFallback<{ threads: WikiThread[] } | null>(raw, z.object({ threads: z.array(WikiThreadSchema) }), null, { endpoint });
  },
  async getProjectWikiThread(this: ApiClient, wsId: string, projectId: string, threadId: string, withSection = false) {
    const endpoint = `${path(projectId)}/threads/${encodeURIComponent(threadId)}?with_section=${withSection}`;
    const raw = await clientFetch<unknown>(this, endpoint, { headers: headers(wsId) });
    return parseWithFallback<{ thread: WikiThread } | null>(raw, z.object({ thread: WikiThreadSchema }), null, { endpoint });
  },
  async createProjectWikiThread(this: ApiClient, wsId: string, projectId: string, page: string, anchor: WikiCommentAnchor, body: string) {
    const endpoint = `${path(projectId)}/pages/${encodeURIComponent(page)}/threads`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(wsId), body: JSON.stringify({ anchor: wikiCommentAnchorToWire(anchor), body_markdown: body }) });
    return parseWithFallback<z.infer<typeof WikiCommentWriteSchema> | null>(raw, WikiCommentWriteSchema, null, { endpoint });
  },
  async replyProjectWikiThread(this: ApiClient, wsId: string, projectId: string, threadId: string, body: string) {
    const endpoint = `${path(projectId)}/threads/${encodeURIComponent(threadId)}/comments`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(wsId), body: JSON.stringify({ body_markdown: body }) });
    return parseWithFallback<z.infer<typeof WikiCommentWriteSchema> | null>(raw, WikiCommentWriteSchema, null, { endpoint });
  },
  async editProjectWikiComment(this: ApiClient, wsId: string, projectId: string, commentId: string, body: string) {
    const endpoint = `${path(projectId)}/comments/${encodeURIComponent(commentId)}`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "PATCH", headers: headers(wsId), body: JSON.stringify({ body_markdown: body }) });
    return parseWithFallback<{ ok: boolean } | null>(raw, z.object({ ok: z.boolean() }), null, { endpoint });
  },
  async deleteProjectWikiComment(this: ApiClient, wsId: string, projectId: string, commentId: string) {
    const endpoint = `${path(projectId)}/comments/${encodeURIComponent(commentId)}`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "DELETE", headers: headers(wsId) });
    return parseWithFallback<{ ok: boolean } | null>(raw, z.object({ ok: z.boolean() }), null, { endpoint });
  },
  async resolveProjectWikiThread(this: ApiClient, wsId: string, projectId: string, threadId: string, resolved: boolean) {
    const endpoint = `${path(projectId)}/threads/${encodeURIComponent(threadId)}/resolve`;
    const raw = await clientFetch<unknown>(this, endpoint, { method: "POST", headers: headers(wsId), body: JSON.stringify({ resolved }) });
    return parseWithFallback<{ ok: boolean } | null>(raw, z.object({ ok: z.boolean() }), null, { endpoint });
  },
};
