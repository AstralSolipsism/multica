// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { agentFolderKeys } from "@multica/core/agents/folder-queries";
import { renderWithI18n } from "../../test/i18n";
import { SquadDetailPage } from "./squad-detail-page";

const mocks = vi.hoisted(() => ({ update: vi.fn(), archive: vi.fn(), push: vi.fn() }));
vi.mock("@multica/core/api", () => ({ api: { updateSquad: mocks.update, deleteSquad: mocks.archive } }));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: "user-1" } }) }));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({ id: "ws-1" }),
  useWorkspacePaths: () => ({ squads: () => "/acme/squads", newAgent: () => "/acme/agents/new", agentDetail: (id: string) => `/acme/agents/${id}` }),
}));
vi.mock("../../navigation", () => ({
  useNavigation: () => ({ pathname: "/acme/squads/sq-1", push: mocks.push }),
  AppLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../layout/breadcrumb-header", () => ({ BreadcrumbHeader: ({ leaf, actions }: { leaf: ReactNode; actions: ReactNode }) => <header>{leaf}{actions}</header> }));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../common/avatar-upload-control", () => ({ AvatarUploadControl: ({ onUploaded }: { onUploaded: (url: string) => void }) => <button onClick={() => onUploaded("emoji:🚀")}>Upload avatar</button> }));
vi.mock("../../editor/content-editor", () => ({ ContentEditor: () => null }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    let data: unknown = [];
    if (queryKey[2] === "squads" && queryKey.length === 4) {
      data = { id: "sq-1", name: "Design", leader_id: "leader", creator_id: "user-1", created_at: "2026-01-01", instructions: "" };
    } else if (queryKey[2] === "squads" && queryKey[4] === "members") {
      data = [{ member_type: "agent", member_id: "candidate", role: "", created_at: "2026-01-01" }];
    } else if (queryKey[2] === "agents") {
      data = [{ id: "candidate", name: "Candidate" }];
    } else if (queryKey[2] === "members") {
      data = [{ user_id: "user-1", role: "owner" }];
    }
    return { data, refetch: vi.fn() };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.archive.mockResolvedValue({});
});

describe("squad changes invalidate the agent directory", () => {
  it.each(["avatar", "rename", "leader", "archive"])("refreshes only this workspace after %s", async (change) => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(agentFolderKeys.tree("ws-1"), { squads: [] });
    client.setQueryData(agentFolderKeys.tree("ws-2"), { squads: [] });
    renderWithI18n(<QueryClientProvider client={client}><SquadDetailPage /></QueryClientProvider>);
    const user = userEvent.setup();
    if (change === "avatar") {
      await user.click(screen.getByRole("button", { name: "Upload avatar" }));
      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("sq-1", { avatar_url: "emoji:🚀" }));
    } else if (change === "rename") {
      await user.click(screen.getByRole("button", { name: "Design" }));
      const input = screen.getByPlaceholderText("Squad name");
      await user.clear(input);
      await user.type(input, "Research");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("sq-1", { name: "Research" }));
    } else if (change === "leader") {
      await user.click(screen.getByRole("button", { name: "Make squad leader" }));
      await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("sq-1", { leader_id: "candidate" }));
    } else {
      await user.click(screen.getByRole("button", { name: "Archive" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Archive" }));
      await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith("sq-1"));
    }
    await waitFor(() => expect(client.getQueryState(agentFolderKeys.tree("ws-1"))?.isInvalidated).toBe(true));
    expect(client.getQueryState(agentFolderKeys.tree("ws-2"))?.isInvalidated).toBe(false);
    client.clear();
  });
});
