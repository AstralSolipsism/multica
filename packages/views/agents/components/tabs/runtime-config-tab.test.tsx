// @vitest-environment jsdom

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "@multica/core/i18n/react";
import type { Agent } from "@multica/core/types";
import enCommon from "../../../locales/en/common.json";
import enAgents from "../../../locales/en/agents.json";
import { RuntimeConfigTab } from "./runtime-config-tab";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

function agentWithConfig(runtimeConfig: Record<string, unknown>): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    runtime_id: "runtime-1",
    name: "Runner",
    description: "",
    instructions: "",
    conversation_starters: [],
    avatar_url: null,
    runtime_mode: "local",
    runtime_config: runtimeConfig,
    custom_args: [],
    visibility: "workspace",
    permission_mode: "public_to",
    invocation_targets: [{ target_type: "workspace", target_id: null }],
    status: "idle",
    max_concurrent_tasks: 1,
    model: "",
    owner_id: "user-1",
    skills: [],
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
    archived_at: null,
    archived_by: null,
  };
}

function renderTab(agent: Agent) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<RuntimeConfigTab agent={agent} onSave={onSave} />, {
    wrapper: Wrapper,
  });
  return { onSave };
}

describe("RuntimeConfigTab gateway guidance", () => {
  it("explains the leave-blank-to-inherit semantics in gateway mode", () => {
    renderTab(agentWithConfig({ mode: "gateway" }));

    expect(screen.getByText(/Only used in Gateway mode/)).toBeVisible();
    expect(screen.getByText(/Every field is optional/)).toBeVisible();
    expect(
      screen.getByText(/from your deployment admin\. Blank inherits/),
    ).toBeVisible();
    expect(screen.getByText(/Issued by the gateway/)).toBeVisible();
    expect(screen.getByLabelText("Host")).toBeEnabled();
    expect(screen.getByLabelText("Auth token")).toBeEnabled();
  });

  it("keeps the endpoint fields inert in local mode", async () => {
    const user = userEvent.setup();
    const { onSave } = renderTab(agentWithConfig({ mode: "local" }));

    expect(screen.getByLabelText("Host")).toBeDisabled();
    expect(screen.getByLabelText("Port")).toBeDisabled();
    expect(screen.getByLabelText("Auth token")).toBeDisabled();

    // The hint stays readable in local mode — it is documentation, not a
    // control — so switching modes is never a surprise.
    expect(screen.getByText(/Only used in Gateway mode/)).toBeVisible();
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Gateway" }));
    expect(screen.getByLabelText("Host")).toBeEnabled();
  });
});
