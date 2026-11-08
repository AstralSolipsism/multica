import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { NavigationProvider } from "../../navigation";
import { renderWithI18n } from "../../test/i18n";
import { RuntimeList } from "./runtime-list";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: [] }),
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "workspace-1",
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector: (state: { user: null }) => unknown) => selector({ user: null }),
    { getState: () => ({ user: null }) },
  ),
}));

describe("RuntimeList quota heading", () => {
  it.each([
    ["en", "Quota"],
    ["zh-Hans", "配额"],
    ["ja", "クォータ"],
    ["ko", "할당량"],
    ["fr", "Quota"],
  ] as const)("renders the column label in %s", (locale, label) => {
    renderWithI18n(
      <WorkspaceSlugProvider slug="acme">
        <NavigationProvider
          value={{
            push: vi.fn(),
            replace: vi.fn(),
            back: vi.fn(),
            pathname: "/acme/runtimes",
            searchParams: new URLSearchParams(),
            hash: "",
            getShareableUrl: (path) => path,
          }}
        >
          <RuntimeList runtimes={[]} now={0} />
        </NavigationProvider>
      </WorkspaceSlugProvider>,
      { locale },
    );

    expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
  });

  it("uses three columns and puts version plus Adapt under the Runtime name in machine detail", () => {
    const runtime: AgentRuntime = {
      id: "runtime-1",
      workspace_id: "workspace-1",
      daemon_id: "daemon-1",
      name: "Claude (dev.local)",
      provider: "claude",
      runtime_mode: "local",
      status: "online",
      owner_id: "user-1",
      visibility: "private",
      device_info: "",
      metadata: { version: "0.1.33" },
      launch_header: "",
      last_seen_at: "2027-01-15T00:00:00Z",
      created_at: "2027-01-15T00:00:00Z",
      updated_at: "2027-01-15T00:00:00Z",
      thinking_adapt: {
        status: "available",
        active_source: "opencode-free",
        last_latency_ms: 290,
        decisions_ok: 12,
        decisions_fallback: 3,
        since: null,
        updated_at: null,
      },
      plan_quota: {
        provider: "claude",
        status: "ok",
        source: "daemon",
        observed_at: 1_800_000_000,
        windows: [{ name: "5h", used_percent: 25, window_minutes: 300, resets_at: null }],
      },
    };
    renderWithI18n(
      <WorkspaceSlugProvider slug="acme">
        <NavigationProvider
          value={{
            push: vi.fn(),
            replace: vi.fn(),
            back: vi.fn(),
            pathname: "/acme/runtimes",
            searchParams: new URLSearchParams(),
            hash: "",
            getShareableUrl: (path) => path,
          }}
        >
          <RuntimeList
            machineDetail
            runtimes={[runtime]}
            now={1_800_000_000_000}
            machineTitle="dev.local"
            runtimeHref={(id) => `/runtimes/${id}`}
          />
        </NavigationProvider>
      </WorkspaceSlugProvider>,
    );

    const grid = screen.getByRole("grid", { name: "Runtime" });
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Runtime",
      "Agents",
      "Quota",
    ]);
    expect(within(grid).queryByRole("columnheader", { name: "Health" })).not.toBeInTheDocument();
    expect(within(grid).queryByRole("columnheader", { name: "Cost" })).not.toBeInTheDocument();
    expect(within(grid).queryByRole("columnheader", { name: "CLI" })).not.toBeInTheDocument();
    expect(within(grid).getByText("v0.1.33")).toBeInTheDocument();
    expect(within(grid).getByText("Adapt · OpenCode Zen (free) · 290ms")).toBeInTheDocument();
    expect(within(grid).getByText("75%")).toBeInTheDocument();
  });
});
