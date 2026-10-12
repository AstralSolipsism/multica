// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./dashboard-guard", () => ({
  DashboardGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@multica/ui/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("./app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("./global-shortcuts", () => ({ GlobalShortcuts: () => null }));
vi.mock("./navigation-progress", () => ({ NavigationProgress: () => null }));
vi.mock("./workspace-presence-prefetch", () => ({
  WorkspacePresencePrefetch: () => null,
}));
vi.mock("../modals/registry", () => ({
  ModalRegistry: () => <div data-testid="modals" />,
}));
// The provider's own behavior is covered in you-should-know/; here it only
// marks where the layout mounts it.
vi.mock("../you-should-know", () => ({
  YouShouldKnowProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="ysk-provider">{children}</div>
  ),
}));

import { DashboardLayout } from "./dashboard-layout";

describe("DashboardLayout", () => {
  it("mounts the You-should-know provider around the page only (OL-194)", () => {
    render(
      <DashboardLayout extra={<div data-testid="chat" />}>
        <div data-testid="page" />
      </DashboardLayout>,
    );
    const provider = screen.getByTestId("ysk-provider");
    expect(provider).toContainElement(screen.getByTestId("page"));
    // Overlays beside the page (chat, modals) carry no anchors.
    expect(provider).not.toContainElement(screen.getByTestId("chat"));
    expect(provider).not.toContainElement(screen.getByTestId("modals"));
  });
});
