// Keyboard behaviour of the assignee picker's search box. Uses the REAL
// PropertyPicker / Base UI Popover — the regression under test lives in
// PropertyPicker's highlight bookkeeping, so mocking it would test nothing.
//
// Regression: the "Unassigned" row is pinned as the picker's first row, which
// also makes it the first `data-picker-item`. PropertyPicker used to reset the
// highlight to index 0 on every keystroke, so typing a name and pressing Enter
// unassigned the issue instead of assigning it to the person being searched
// for. The empty row is now excluded from the search-result Enter default while
// staying reachable by arrow key.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import enIssues from "../../../locales/en/issues.json";
import { AssigneePicker } from "./assignee-picker";

const MEMBERS = [
  { user_id: "user-1", name: "Ada Lovelace", role: "member" },
  { user_id: "user-2", name: "Grace Hopper", role: "member" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "members") return { data: MEMBERS };
    return { data: [] };
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace-1" }));
vi.mock("@multica/core/auth", () => ({ useAuthStore: () => ({ id: "user-1" }) }));
vi.mock("@multica/core/agents", () => ({ isAgentRuntimeBound: () => true }));
vi.mock("@multica/core/permissions", () => ({
  canAssignAgentToIssue: () => ({ allowed: true }),
}));
vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Ada Lovelace" }),
}));
vi.mock("@multica/core/workspace/queries", () => ({
  memberListOptions: () => ({ queryKey: ["members"] }),
  agentListOptions: () => ({ queryKey: ["agents"] }),
  squadListOptions: () => ({ queryKey: ["squads"] }),
  assigneeFrequencyOptions: () => ({ queryKey: ["frequency"] }),
}));
vi.mock("../../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));

const SEARCH_PLACEHOLDER = "Assign to...";

function renderPicker(onUpdate: () => void) {
  return render(
    <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      {/* Controlled open: the picker is the subject, its trigger is not. */}
      <AssigneePicker
        assigneeType={null}
        assigneeId={null}
        onUpdate={onUpdate}
        open
        onOpenChange={() => {}}
      />
    </I18nProvider>,
  );
}

describe("AssigneePicker search keyboard defaults", () => {
  it("assigns the first match on Enter instead of unassigning", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker(onUpdate);

    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "grace");
    await user.keyboard("{Enter}");

    expect(onUpdate).toHaveBeenCalledWith({
      assignee_type: "member",
      assignee_id: "user-2",
    });
  });

  // OL-466: the DAG selection node and the shared context menu open the
  // picker from a menu item and anchor it on an invisible <span>. Base UI's
  // trigger dev-check errors when `render` gets a non-<button> while
  // `nativeButton` stays true — the fix routes host-element anchors down the
  // non-native path in PropertyPicker. The check only fires outside
  // production builds, which is exactly what vitest runs as.
  it("renders a non-button anchor trigger without the Base UI native-button console error", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(
        <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
          <AssigneePicker
            assigneeType={null}
            assigneeId={null}
            onUpdate={() => {}}
            open
            onOpenChange={() => {}}
            triggerRender={
              <span aria-hidden className="pointer-events-none fixed" />
            }
            trigger={<span />}
          />
        </I18nProvider>,
      );

      const baseUiErrors = consoleError.mock.calls.filter(([message]) =>
        String(message).includes("native <button>"),
      );
      expect(baseUiErrors).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("leaves Enter inert when the query matches nobody", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderPicker(onUpdate);

    await user.type(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER), "zzzznomatch");
    await user.keyboard("{Enter}");

    expect(onUpdate).not.toHaveBeenCalled();
  });
});
