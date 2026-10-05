import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
