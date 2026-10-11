// @vitest-environment jsdom

/**
 * Summary-level tip anchor registration (OL-193): WorkspaceAgentWorkingChip
 * registers a `summary` anchor carrying the header-supplied scope while
 * agents are working, and stays out of the registry otherwise.
 */

import { cleanup, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkingAgentSummary } from "@multica/core/types";
import {
  createTipAnchorRegistry,
  type TipAnchorRegistry,
} from "@multica/core/you-should-know/anchors";
import { TipAnchorRegistryProvider } from "../../you-should-know/anchors/tip-anchor-context";

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
// assert on the wrapper (same approach as the other chip tests). The trigger
// carries the chip's button via its `render` prop — clone it with the
// children merged in or the avatar stack never mounts.
vi.mock("@multica/ui/components/ui/hover-card", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    HoverCard: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="hover-card">{children}</div>
    ),
    HoverCardTrigger: ({
      render: renderProp,
      children,
    }: {
      render?: React.ReactElement;
      children?: React.ReactNode;
    }) => {
      if (!renderProp) return <span data-testid="hover-card-trigger">{children}</span>;
      // cloneElement(el, props, ...children) REPLACES the element's own
      // children whenever a third argument is passed — even undefined — so
      // merge only when the trigger actually carries children.
      return children !== undefined && children !== null
        ? React.cloneElement(renderProp, undefined, children)
        : renderProp;
    },
    HoverCardContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});

import { WorkspaceAgentWorkingChip } from "./workspace-agent-working-chip";

const SCOPE = { "issue-1": "OL-1", "issue-2": "OL-2" } as const;

function makeAgent(id = "agent-1"): WorkingAgentSummary {
  return { id, running_task_count: 1 };
}

let registry: TipAnchorRegistry;

function renderChip(agents: readonly WorkingAgentSummary[] | undefined, scope?: typeof SCOPE) {
  return render(
    <TipAnchorRegistryProvider registry={registry}>
      <WorkspaceAgentWorkingChip
        value={false}
        onToggle={() => {}}
        agents={agents}
        tipAnchorScope={scope}
      />
    </TipAnchorRegistryProvider>,
  );
}

function registeredDescriptors() {
  return Object.values(registry.getState().anchors).map((a) => a.descriptor);
}

beforeEach(() => {
  cleanup();
  registry = createTipAnchorRegistry();
});

describe("WorkspaceAgentWorkingChip tip anchor", () => {
  it("registers a summary anchor with the scope while agents are working", () => {
    renderChip([makeAgent()], SCOPE);
    expect(registeredDescriptors()).toEqual([{ level: "summary", scope: SCOPE }]);
  });

  it("does not register when the projection resolved to nobody working", () => {
    renderChip([], SCOPE);
    expect(registeredDescriptors()).toEqual([]);
  });

  it("does not register while the projection is unresolved", () => {
    renderChip(undefined, SCOPE);
    expect(registeredDescriptors()).toEqual([]);
  });

  it("does not register without a scope, even with agents working", () => {
    renderChip([makeAgent()]);
    expect(registeredDescriptors()).toEqual([]);
  });
});
