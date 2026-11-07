// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import type { OmpRuntimeConfig } from "@multica/core/agents";
import type { Agent, AgentRuntime } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

const panel = vi.hoisted(() => ({
  current: null as null | {
    value: OmpRuntimeConfig;
    onChange: (next: OmpRuntimeConfig) => void;
  },
}));

vi.mock("../../common/avatar-upload-control", () => ({
  AvatarUploadControl: () => <div />,
}));
vi.mock("./inspector/model-picker", () => ({ ModelPicker: () => <div /> }));
vi.mock("./inspector/runtime-picker", () => ({ RuntimePicker: () => <div /> }));
vi.mock("./inspector/thinking-prop-row", () => ({ ThinkingSettingField: () => <div /> }));
vi.mock("./inspector/service-tier-setting-field", () => ({
  ServiceTierSettingField: () => <div />,
}));
vi.mock("./omp-runtime-config", () => ({
  OmpRuntimeConfigPanel: (props: NonNullable<typeof panel.current>) => {
    panel.current = props;
    return <div data-testid="omp-panel" />;
  },
}));

import { AgentDetailInspector } from "./agent-detail-inspector";

const runtime = {
  id: "runtime-omp",
  workspace_id: "workspace-1",
  daemon_id: "daemon-1",
  name: "OMP",
  runtime_mode: "local",
  provider: "omp",
  launch_header: "",
  status: "offline",
  device_info: "host",
  metadata: {},
  owner_id: "user-1",
  visibility: "public",
  last_seen_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} satisfies AgentRuntime;

const agent = {
  id: "agent-1",
  workspace_id: "workspace-1",
  name: "Lambda",
  description: "",
  runtime_id: runtime.id,
  runtime_config: { custom_key: "keep", slow_model: "stale/model" },
  model: "openai-codex/gpt-6.1-sol",
  instructions: "",
  avatar_url: null,
  runtime_mode: "local",
  custom_args: [],
  visibility: "private",
  max_concurrent_tasks: 1,
  permission_mode: "private",
  invocation_targets: [],
  status: "idle",
  owner_id: "user-1",
  skills: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  archived_at: null,
  archived_by: null,
} as Agent;

describe("AgentDetailInspector OMP persistence", () => {
  beforeEach(() => {
    panel.current = null;
  });
  afterEach(cleanup);

  it("blocks an incomplete handoff and saves the completed config", async () => {
    const onUpdate = vi.fn(async () => {});
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <AgentDetailInspector
          agent={agent}
          runtime={runtime}
          runtimes={[runtime]}
          members={[]}
          currentUserId="user-1"
          canEdit
          onUpdate={onUpdate}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("omp-panel")).toBeInTheDocument();
    act(() => panel.current?.onChange({ executionMode: "plan_yolo" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 750));
    });
    expect(onUpdate).not.toHaveBeenCalled();

    act(() =>
      panel.current?.onChange({
        executionMode: "plan_yolo",
        handoffModel: "zai/glm-5.3",
      }),
    );
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onUpdate).toHaveBeenCalledWith("agent-1", {
      runtime_config: {
        custom_key: "keep",
        execution_mode: "plan_yolo",
        handoff_model: "zai/glm-5.3",
      },
    });
    queryClient.clear();
  });
});
