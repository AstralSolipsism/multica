import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enOnboarding from "../locales/en/onboarding.json";
import enWorkspace from "../locales/en/workspace.json";

const workspaceState = vi.hoisted(() => ({ fresh: false }));
afterEach(() => { workspaceState.fresh = false; });

const TEST_RESOURCES = {
  en: { common: enCommon, onboarding: enOnboarding, workspace: enWorkspace },
};

vi.mock("../auth", () => ({ useLogout: () => vi.fn() }));

vi.mock("@multica/core/config", () => ({
  useConfigStore: (
    selector: (s: { workspaceCreationDisabled: boolean; daemonAppUrl: string }) => unknown,
  ) => selector({ workspaceCreationDisabled: false, daemonAppUrl: "" }),
}));

vi.mock("@multica/core/api", () => ({
  api: { getBaseUrl: () => "https://multica.ai" },
}));

vi.mock("@multica/core/workspace/mutations", () => ({
  useCreateWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@multica/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: unknown }) => unknown) =>
      selector({ user: { id: "u-1", onboarding_questionnaire: {} } }),
    { getState: () => ({ user: { id: "u-1" } }) },
  ),
}));

// Returning one workspace proves new-workspace mode does not offer to
// continue with it.
vi.mock("@multica/core/workspace", () => {
  return {
    useWorkspaceList: () => ({
      workspaces: workspaceState.fresh ? [] : [{ id: "ws-1", name: "Existing", slug: "existing" }],
      ready: true,
    }),
  };
});

vi.mock("@multica/core/onboarding", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@multica/core/onboarding",
  );
  return { ...actual, useBootstrapMika: () => ({ mutateAsync: vi.fn() }) };
});

import { OnboardingFlow } from "./onboarding-flow";

function renderFlow(props: Record<string, unknown>) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <OnboardingFlow onComplete={vi.fn()} {...props} />
    </I18nProvider>,
  );
}

describe("OnboardingFlow — new-workspace mode", () => {
  it("starts at the workspace step instead of the product intro", () => {
    renderFlow({ mode: "new_workspace", onCancel: vi.fn() });

    // The welcome screen teaches what Multica is; someone creating a second
    // workspace already knows, so the flow opens on naming it.
    expect(
      screen.getByRole("heading", { name: /Name your workspace/i }),
    ).toBeInTheDocument();
  });

  it("always creates a workspace rather than offering the existing one", () => {
    renderFlow({ mode: "new_workspace", onCancel: vi.fn() });

    // First-run onboarding offers "Continue with {name}" when an abandoned
    // workspace exists. Doing that here would defeat the whole intent.
    expect(screen.queryByText(/Continue with/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Workspace name")).toBeInTheDocument();
  });

  it("still opens on the product intro in first-run mode", () => {
    renderFlow({});

    expect(
      screen.queryByRole("heading", { name: /Name your workspace/i }),
    ).not.toBeInTheDocument();
  });
});

describe("OnboardingFlow — fork first-use contract", () => {
  it.each(["web", "desktop"])(
    "%s continues directly to workspace setup without a persona questionnaire",
    async (platform) => {
      workspaceState.fresh = true;
      const user = userEvent.setup();
      renderFlow(platform === "web" ? { runtimeInstructions: <div>CLI instructions</div> } : {});
      await user.click(screen.getByRole("button", {
        name: platform === "web" ? "Continue on web" : "Start exploring",
      }));
      expect(screen.getByRole("heading", { name: /Name your workspace/i })).toBeInTheDocument();
      expect(screen.queryByText("Tell us a bit about you.")).not.toBeInTheDocument();
      expect(screen.queryByText("Which best describes you?")).not.toBeInTheDocument();
      expect(screen.queryAllByText("About you")).toHaveLength(0);
    },
  );
});
