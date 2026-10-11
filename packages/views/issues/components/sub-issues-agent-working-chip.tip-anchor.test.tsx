// @vitest-environment jsdom

/**
 * Summary-level tip anchor registration (OL-193): SubIssuesAgentWorkingChip
 * registers a `summary` anchor carrying the detail page's child-issue scope
 * while agents are working on the children.
 */

import { cleanup, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWorkingAgent } from "@multica/core/types";
import {
  createTipAnchorRegistry,
  type TipAnchorRegistry,
} from "@multica/core/you-should-know/anchors";
import { TipAnchorRegistryProvider } from "../../you-should-know/anchors/tip-anchor-context";

const mockState = vi.hoisted(() => ({
  agents: [] as WorkspaceWorkingAgent[],
}));

vi.mock("@multica/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

vi.mock("@multica/core/agents", () => ({
  workspaceWorkingAgentsOptions: (...args: unknown[]) => ({
    queryKey: ["working-agents", ...args],
  }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );
  return { ...actual, useQuery: () => ({ data: mockState.agents }) };
});

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (
      selector: (keys: Record<string, Record<string, string>>) => string,
      options?: { count?: number },
    ) => {
      const key = selector(
        new Proxy(
          {},
          {
            get: (_t, ns: string) =>
              new Proxy({}, { get: (_n, k: string) => `${ns}.${k}` }),
          },
        ) as Record<string, Record<string, string>>,
      );
      return options?.count !== undefined ? `${key}:${options.count}` : key;
    },
  }),
}));

// The hover card only portals its content once open; mock the primitive and
// assert on the wrapper (same approach as the existing chip test).
vi.mock("@multica/ui/components/ui/hover-card", () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="hover-card">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="hover-card-trigger">{children}</span>
  ),
  HoverCardContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { SubIssuesAgentWorkingChip } from "./sub-issues-agent-working-chip";

const SCOPE = { "child-1": "OL-11", "child-2": "OL-12" } as const;

function makeAgent(): WorkspaceWorkingAgent {
  return {
    id: "agent-1",
    name: "Agent One",
    avatar_url: null,
    running_task_count: 1,
    issue_ids: ["child-1"],
  };
}

let registry: TipAnchorRegistry;

function renderChip(scope?: typeof SCOPE) {
  return render(
    <TipAnchorRegistryProvider registry={registry}>
      <SubIssuesAgentWorkingChip parentIssueId="parent-1" tipAnchorScope={scope} />
    </TipAnchorRegistryProvider>,
  );
}

function registeredDescriptors() {
  return Object.values(registry.getState().anchors).map((a) => a.descriptor);
}

beforeEach(() => {
  cleanup();
  registry = createTipAnchorRegistry();
  mockState.agents = [makeAgent()];
});

describe("SubIssuesAgentWorkingChip tip anchor", () => {
  it("registers a summary anchor with the child-issue scope while agents work", () => {
    renderChip(SCOPE);
    expect(registeredDescriptors()).toEqual([{ level: "summary", scope: SCOPE }]);
  });

  it("does not register when no agent works on the children", () => {
    mockState.agents = [];
    renderChip(SCOPE);
    expect(registeredDescriptors()).toEqual([]);
  });

  it("does not register without a scope, even with agents working", () => {
    renderChip();
    expect(registeredDescriptors()).toEqual([]);
  });
});
