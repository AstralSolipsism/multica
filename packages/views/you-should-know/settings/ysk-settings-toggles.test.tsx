// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithI18n } from "../../test/i18n";

const state = vi.hoisted(() => ({
  workspaceEnabled: true,
  // Omits you_should_know_enabled from the workspace settings entirely —
  // the "key never set" case (a workspace created before the feature).
  missingWorkspaceKey: false,
  personalEnabled: true,
  preferences: { you_should_know: undefined } as Record<string, unknown>,
  savedPatch: undefined as unknown,
  updateWorkspaceError: null as Error | null,
  mutateError: null as Error | null,
}));

const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multica/core/paths", () => ({
  useCurrentWorkspace: () => ({
    id: "ws-1",
    name: "Acme",
    settings: state.missingWorkspaceKey
      ? { github_enabled: true }
      : {
          you_should_know_enabled: state.workspaceEnabled,
          github_enabled: true,
        },
  }),
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));
vi.mock("@multica/core/you-should-know", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/you-should-know")>(
    "@multica/core/you-should-know",
  );
  return {
    ...actual,
    useYouShouldKnowEnabled: () => ({
      workspaceEnabled: state.workspaceEnabled,
      personalEnabled: state.personalEnabled,
      enabled: state.workspaceEnabled && state.personalEnabled,
    }),
  };
});
vi.mock("@multica/core/api", () => ({
  api: { updateWorkspace: mockUpdateWorkspace },
}));
vi.mock("@multica/core/workspace/queries", () => ({
  workspaceKeys: { list: () => ["workspaces"] },
}));
vi.mock("@multica/core/notification-preferences/queries", () => ({
  notificationPreferenceOptions: () => ({
    queryKey: ["notification-preferences", "ws-1"],
    queryFn: vi.fn(),
  }),
}));
vi.mock("@multica/core/notification-preferences/mutations", () => ({
  useUpdateNotificationPreferences: () => ({
    mutate: mockMutate,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: mockToastError },
}));

import { YouShouldKnowWorkspaceSection } from "./workspace-toggle";
import { YouShouldKnowPersonalRow } from "./personal-toggle";
import { useSettingsSearchIndex } from "../../settings/components/use-settings-search-index";

function withQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["notification-preferences", "ws-1"], {
    workspace_id: "ws-1",
    preferences: state.preferences,
  });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.workspaceEnabled = true;
  state.missingWorkspaceKey = false;
  state.personalEnabled = true;
  state.preferences = {};
  state.savedPatch = undefined;
  state.updateWorkspaceError = null;
  state.mutateError = null;
  mockUpdateWorkspace.mockImplementation(
    async (_id: string, payload: object) => {
      if (state.updateWorkspaceError) throw state.updateWorkspaceError;
      return payload;
    },
  );
  mockMutate.mockImplementation(
    (_prefs: Record<string, unknown>, options?: { onError?: (e: Error) => void }) => {
      if (state.mutateError) options?.onError?.(state.mutateError);
    },
  );
});

afterEach(cleanup);

describe("YouShouldKnowWorkspaceSection", () => {
  it("reads the workspace switch; default off is rendered as off", async () => {
    state.workspaceEnabled = false;
    withQuery(<YouShouldKnowWorkspaceSection canManage />);
    const toggle = screen.getByRole("switch", { name: "Show bystander tips while agents work" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    state.workspaceEnabled = true;
    cleanup();
    withQuery(<YouShouldKnowWorkspaceSection canManage />);
    expect(screen.getByRole("switch", { name: /bystander tips/ })).toHaveAttribute("aria-checked", "true");
  });

  it("persists you_should_know_enabled merged over the existing settings", async () => {
    withQuery(<YouShouldKnowWorkspaceSection canManage />);
    fireEvent.click(screen.getByRole("switch", { name: /bystander tips/ }));

    await waitFor(() => {
      expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws-1", {
        settings: expect.objectContaining({
          you_should_know_enabled: false,
          github_enabled: true,
        }),
      });
    });
  });

  it("shows a toast when saving the workspace switch fails", async () => {
    state.updateWorkspaceError = new Error("boom");
    withQuery(<YouShouldKnowWorkspaceSection canManage />);
    fireEvent.click(screen.getByRole("switch", { name: /bystander tips/ }));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith("boom");
    });
  });

  it("keeps the switch read-only for non-managers", () => {
    withQuery(<YouShouldKnowWorkspaceSection canManage={false} />);
    expect(screen.getByRole("switch", { name: /bystander tips/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("anchors both toggles for the settings search", () => {
    // Probe component: the index hook needs a component body.
    function IndexProbe() {
      const index = useSettingsSearchIndex([
        { value: "workspace", label: "Workspace" },
        { value: "notifications", label: "Notifications" },
      ]);
      return <ul>{index.map((e) => <li key={`${e.tab}#${e.anchor ?? ""}`}>{`${e.tab}#${e.anchor ?? ""}:${e.title}`}</li>)}</ul>;
    }
    renderWithI18n(<IndexProbe />);

    expect(screen.getByText("workspace#you-should-know:Show bystander tips while agents work")).toBeInTheDocument();
    expect(screen.getByText("notifications#you-should-know:You should know")).toBeInTheDocument();

    // The anchors the entries point at exist on the rendered pages.
    cleanup();
    withQuery(<YouShouldKnowWorkspaceSection canManage />);
    expect(
      document.querySelector('[data-settings-anchor="you-should-know"]'),
    ).not.toBeNull();
    cleanup();
    withQuery(<YouShouldKnowPersonalRow />);
    expect(
      document.querySelector('[data-settings-anchor="you-should-know"]'),
    ).not.toBeNull();
  });

  it("drops the personal entry from the search index while the workspace switch is off", () => {
    state.workspaceEnabled = false;
    function IndexProbe() {
      const index = useSettingsSearchIndex([
        { value: "workspace", label: "Workspace" },
        { value: "notifications", label: "Notifications" },
      ]);
      return <ul>{index.map((e) => <li key={`${e.tab}#${e.anchor ?? ""}`}>{`${e.tab}#${e.anchor ?? ""}`}</li>)}</ul>;
    }
    const { unmount } = renderWithI18n(<IndexProbe />);

    expect(screen.queryByText(/^notifications#you-should-know/)).toBeNull();
    // The workspace entry stays: that is the row an admin searches for to
    // turn the feature on.
    expect(screen.getByText(/^workspace#you-should-know/)).toBeInTheDocument();
    unmount();
  });

  // OL-269: workspaces created before the feature (or whose settings were
  // never written) have no you_should_know_enabled key — that must count as
  // off, exactly like an explicit false.
  it("drops the personal entry when the settings key is missing entirely", () => {
    state.missingWorkspaceKey = true;
    function IndexProbe() {
      const index = useSettingsSearchIndex([
        { value: "workspace", label: "Workspace" },
        { value: "notifications", label: "Notifications" },
      ]);
      return <ul>{index.map((e) => <li key={`${e.tab}#${e.anchor ?? ""}`}>{`${e.tab}#${e.anchor ?? ""}`}</li>)}</ul>;
    }
    const { unmount } = renderWithI18n(<IndexProbe />);

    expect(screen.queryByText(/^notifications#you-should-know/)).toBeNull();
    expect(screen.getByText(/^workspace#you-should-know/)).toBeInTheDocument();
    unmount();
  });

  it("finds the workspace switch by the feature name", async () => {
    const { searchSettings } = await import("../../settings/components/settings-search");
    function IndexProbe() {
      const index = useSettingsSearchIndex([
        { value: "workspace", label: "Workspace" },
        { value: "notifications", label: "Notifications" },
      ]);
      return (
        <ul>
          {searchSettings(index, "You should know").map((e) => (
            <li key={`${e.tab}#${e.anchor ?? ""}`}>{`${e.tab}#${e.anchor ?? ""}`}</li>
          ))}
        </ul>
      );
    }
    renderWithI18n(<IndexProbe />);

    // The feature name reaches the workspace row through its section-title
    // description, and the personal row by its own label.
    expect(screen.getByText("workspace#you-should-know")).toBeInTheDocument();
    expect(screen.getByText("notifications#you-should-know")).toBeInTheDocument();
  });
});

describe("YouShouldKnowPersonalRow", () => {
  it("is hidden while the workspace switch is off", () => {
    state.workspaceEnabled = false;
    const { container } = withQuery(<YouShouldKnowPersonalRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it("defaults to on and saves muted on first toggle off", () => {
    withQuery(<YouShouldKnowPersonalRow />);
    const toggle = screen.getByRole("switch", { name: "You should know" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ you_should_know: "muted" }),
      expect.anything(),
    );
  });

  it("turning it back on omits the key (default all)", () => {
    state.preferences = { you_should_know: "muted" };
    withQuery(<YouShouldKnowPersonalRow />);
    fireEvent.click(screen.getByRole("switch", { name: "You should know" }));
    expect(mockMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ you_should_know: expect.anything() }),
      expect.anything(),
    );
  });

  it("shows a toast when saving the preference fails", () => {
    state.mutateError = new Error("pref boom");
    withQuery(<YouShouldKnowPersonalRow />);
    fireEvent.click(screen.getByRole("switch", { name: "You should know" }));

    expect(mockToastError).toHaveBeenCalledWith("pref boom");
  });
});
