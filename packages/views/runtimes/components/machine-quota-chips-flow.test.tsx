// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRuntime } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";
import { buildRuntimeMachines } from "./runtime-machines";
import { MachineQuotaChips } from "./machine-quota-chips";

const NOW_SEC = 1_800_000_000;
const NOW = NOW_SEC * 1000;

function runtime(index: number): AgentRuntime {
  return {
    id: `runtime-${index}`,
    workspace_id: "workspace-1",
    daemon_id: "daemon-1",
    name: `Runtime ${index} (dev.local)`,
    provider: "claude",
    runtime_mode: "local",
    status: "online",
    owner_id: "user-1",
    visibility: "private",
    device_info: "",
    metadata: {},
    launch_header: "",
    last_seen_at: new Date(NOW).toISOString(),
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    plan_quota: {
      provider: "claude",
      status: "ok",
      source: "daemon",
      observed_at: NOW_SEC - 60,
      windows: [
        { name: "5h", used_percent: 25, window_minutes: 300, resets_at: null },
      ],
    },
  };
}

function renderMachines(count: number) {
  const machine = buildRuntimeMachines(
    Array.from({ length: count }, (_, index) => runtime(index + 1)),
    { now: NOW },
  )[0]!;
  return renderWithI18n(<MachineQuotaChips machine={machine} now={NOW} />);
}

describe("machine quota chip wrapping", () => {
  it("shows all eight subjects without an overflow entry", () => {
    renderMachines(8);

    expect(screen.getAllByLabelText(/Runtime \d: 75% left/)).toHaveLength(8);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it("wraps the first eight and lists only additional subjects in the overflow card", async () => {
    renderMachines(10);

    expect(screen.getAllByLabelText(/Runtime \d: 75% left/)).toHaveLength(8);
    expect(screen.queryByLabelText("Runtime 9: 75% left")).not.toBeInTheDocument();
    const overflow = screen.getByLabelText("2 more quotas");
    await userEvent.hover(overflow);

    expect(await screen.findByText("2 more quotas")).toBeInTheDocument();
    expect(screen.getByText("Runtime 9")).toBeInTheDocument();
    expect(screen.getByText("Runtime 10")).toBeInTheDocument();
    expect(screen.queryByText("Runtime 1", { selector: '[data-slot="hover-card-content"] *' })).not.toBeInTheDocument();
  });
});
