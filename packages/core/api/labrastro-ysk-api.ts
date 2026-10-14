// Labrastro fork: You Should Know (YSK) member-facing API (OL-187 §13 G).
// These endpoints exist only on servers running OL-188+; older servers answer
// 404, which callers present as an "unsupported server" state.
import type { ApiClient } from "./client";
import type { ChatSession } from "../types/chat";
import { ChatSessionSchema } from "./schemas";
import { clientFetch, installLabrastroApiMethods, parseRequiredResponse } from "./labrastro-api-helpers";
import {
  IssueTipListSchema,
  SetTipStateRequestSchema,
  type IssueTipList,
  type SetTipStateRequest,
} from "./labrastro-ysk-schemas";

const labrastroYskApi = {
  async openTipChat(this: ApiClient, tipId: string): Promise<ChatSession> {
    const path = `/api/tips/${tipId}/chat`;
    const raw = await clientFetch<unknown>(this, path, { method: "POST" });
    return parseRequiredResponse(raw, ChatSessionSchema.refine(
      (session) => session.id.length > 0 && session.tip_source !== undefined,
    ), `POST ${path}`);
  },

  async listIssueTips(
    this: ApiClient,
    issueId: string,
    status: "valid" | "all" = "valid",
  ): Promise<IssueTipList> {
    const raw = await clientFetch<unknown>(
      this,
      `/api/issues/${issueId}/tips?status=${status}`,
    );
    return parseRequiredResponse(raw, IssueTipListSchema, `GET /api/issues/${issueId}/tips`);
  },

  // The workspace comes from the request context (X-Workspace-ID), same as
  // /api/working-agents.
  async listActiveTips(this: ApiClient): Promise<IssueTipList> {
    const raw = await clientFetch<unknown>(this, "/api/tips/active");
    return parseRequiredResponse(raw, IssueTipListSchema, "GET /api/tips/active");
  },

  async setTipState(
    this: ApiClient,
    tipId: string,
    request: SetTipStateRequest,
  ): Promise<void> {
    await clientFetch<unknown>(this, `/api/tips/${tipId}/state`, {
      method: "POST",
      body: JSON.stringify(SetTipStateRequestSchema.parse(request)),
    });
  },
};

export type LabrastroYskApi = typeof labrastroYskApi;

export function installLabrastroYskApi(target: { prototype: ApiClient }): void {
  installLabrastroApiMethods(target, labrastroYskApi);
}
