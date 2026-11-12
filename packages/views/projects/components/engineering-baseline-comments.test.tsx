import { useState, useImperativeHandle, type Ref } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance, type WikiThread } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { WikiCommentsPanel, type WikiDiscussion } from "./engineering-baseline-comments";
import { renderWithI18n } from "../../test/i18n";

vi.mock("@multica/core/auth", () => ({ useAuthStore: (select: (s: unknown) => unknown) => select({ user: { id: "me" } }) }));
vi.mock("@multica/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: (_type: string, id: string) => id, getActorInitials: () => "ME" }) }));
vi.mock("../../editor", () => ({
  ContentEditor: ({ ref, defaultValue, onUpdate }: { ref: Ref<unknown>; defaultValue: string; onUpdate: (s: string) => void }) => {
    const [body, setBody] = useState(defaultValue), [locked, setLocked] = useState(false);
    useImperativeHandle(ref, () => ({ getMarkdown: () => body, clearContent: () => setBody(""), setInputLocked: setLocked }));
    return <textarea aria-label="Draft" value={body} disabled={locked} onChange={(e) => { setBody(e.target.value); onUpdate(e.target.value); }} />;
  },
  ReadonlyContent: ({ content }: { content: string }) => <p>{content}</p>,
}));

const anchor = { kind: "text" as const, sectionAnchor: "A", sectionTitle: "A", exact: "needle", prefix: "", suffix: "", revisionNumber: 4, start: undefined };
const thread: WikiThread = { id: "thread", pageId: "page", anchor, location: { state: "section_only", sectionAnchor: "A", start: undefined }, issueId: null, identifier: "", resolvedAt: null, resolvedByType: null, resolvedById: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", section: null, comments: [{ id: "comment", authorType: "member", authorId: "me", bodyMarkdown: "Original body", authorTaskId: null, createdAt: "2026-11-01T00:00:00Z", editedAt: null }] };
const create = vi.fn(), reply = vi.fn(), edit = vi.fn(), remove = vi.fn(), resolve = vi.fn();
let admin = false;
beforeEach(() => {
  vi.resetAllMocks(); admin = false;
  for (const fn of [create, reply]) fn.mockResolvedValue({ thread, woke: [] });
  for (const fn of [edit, remove, resolve]) fn.mockResolvedValue({ ok: true });
  setApiInstance({ createProjectWikiThread: create, replyProjectWikiThread: reply, editProjectWikiComment: edit, deleteProjectWikiComment: remove, resolveProjectWikiThread: resolve, listMembers: async () => [{ user_id: "me", role: admin ? "owner" : "member" }] } as unknown as ApiClient);
});
function renderPanel(initial: WikiDiscussion, threads = [thread]) {
  function Harness() {
    const [discussion, onDiscussion] = useState(initial);
    return <WikiCommentsPanel workspaceId="ws" projectId="project" pageId="page" pageSlug="page" threads={threads} discussion={discussion} onDiscussion={onDiscussion} loading={false} loadError={false} />;
  }
  return renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><Harness /></QueryClientProvider>, { locale: "en" });
}
it("keeps a failed draft and retries the original selector", async () => {
  create.mockRejectedValueOnce(new Error("offline"));
  renderPanel({ mode: "compose", anchor });
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Retry me" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByLabelText("Draft")).toHaveValue("Retry me");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create).toHaveBeenLastCalledWith("ws", "project", "page", anchor, "Retry me");
  expect(await screen.findByText("Original body")).toBeVisible();
});
it("edits only the author's comment and deletes an empty thread back to the list", async () => {
  renderPanel({ mode: "thread", id: "thread" });
  expect(screen.getByText(/Original text has changed/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getAllByLabelText("Draft")[0]!, { target: { value: "Edited body" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]!);
  await waitFor(() => expect(edit).toHaveBeenCalledWith("ws", "project", "comment", "Edited body"));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete this comment?" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("ws", "project", "comment"));
  expect(await screen.findByRole("button", { name: "Open (1)" })).toBeVisible();
});
it("allows members to resolve and admins to delete but not edit another author", async () => {
  admin = true;
  renderPanel({ mode: "thread", id: "thread" }, [{ ...thread, comments: [{ ...thread.comments[0]!, authorType: "agent", authorId: "agent" }] }]);
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Delete" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("ws", "project", "thread", true));
});
it("reopens a resolved thread without a reply composer", async () => {
  renderPanel({ mode: "thread", id: "thread" }, [{ ...thread, resolvedAt: "2026-11-02T00:00:00Z", resolvedByType: "agent", resolvedById: "agent" }]);
  expect(screen.queryByLabelText("Draft")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith("ws", "project", "thread", false));
});
