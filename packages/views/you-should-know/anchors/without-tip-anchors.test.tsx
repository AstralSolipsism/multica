// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createTipAnchorRegistry } from "@multica/core/you-should-know/anchors";
import { renderWithI18n } from "../../test/i18n";
import { AgentAvatarStack } from "../../agents/components/agent-avatar-stack";
import { TipAnchorRegistryProvider } from "./tip-anchor-context";
import { WithoutTipAnchors } from "./without-tip-anchors";

vi.mock("@multica/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

describe("WithoutTipAnchors", () => {
  it("keeps the anchors inside it out of the page registry, and only those", () => {
    const registry = createTipAnchorRegistry();
    renderWithI18n(
      <TipAnchorRegistryProvider registry={registry}>
        <AgentAvatarStack agentIds={["a1"]} tipAnchor={{ level: "row", issueId: "page-row" }} />
        <WithoutTipAnchors>
          <AgentAvatarStack
            agentIds={["a2"]}
            tipAnchor={{ level: "detail_header", issueId: "embedded-detail" }}
          />
        </WithoutTipAnchors>
      </TipAnchorRegistryProvider>,
    );

    const anchors = Object.values(registry.getState().anchors);
    expect(anchors.map((anchor) => anchor.descriptor)).toEqual([
      { level: "row", issueId: "page-row" },
    ]);
  });
});
