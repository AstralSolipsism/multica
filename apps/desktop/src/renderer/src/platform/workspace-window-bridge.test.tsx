import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { getActiveTab, scrollMementoKey, useTabStore } from "@/stores/tab-store";
import { WorkspaceWindowBridge } from "./workspace-window-bridge";

vi.mock("@multica/core/auth", () => ({ useAuthStore: () => null }));
vi.mock("@multica/core/workspace", () => ({ useWorkspaceList: () => ({ workspaces: [] }) }));
vi.mock("@multica/views/i18n", () => ({ useT: () => ({ t: vi.fn() }) }));

afterEach(cleanup);

it("clears only the destination highlight after a handed-off comment link lands", () => {
  useTabStore.getState().reset();
  const route = "/beta/issues/OL-2";
  useTabStore.getState().switchWorkspace("beta", route);
  const tab = getActiveTab(useTabStore.getState())!;
  useTabStore.getState().commitViewState(tab.id, route, "highlight:issue-2", "old-comment");
  useTabStore.getState().commitViewState(tab.id, route, "editor", "draft");
  let deliver: ((path: string) => void) | undefined;
  Object.defineProperty(window, "desktopAPI", {
    configurable: true,
    value: { onOpenWorkspacePath: (callback: typeof deliver) => { deliver = callback; return () => {}; } },
  });
  render(<WorkspaceWindowBridge />);

  act(() => deliver!(`${route}#comment-new-comment`));

  const active = getActiveTab(useTabStore.getState())!;
  expect(active.url).toBe(`${route}#comment-new-comment`);
  expect(active.memento.view[scrollMementoKey(route, "highlight:issue-2")]).toBeUndefined();
  expect(active.memento.view[scrollMementoKey(route, "editor")]).toBe("draft");
});
