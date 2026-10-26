// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDraft } from "@multica/core/agents";
import type { RuntimeDevice, RuntimeModelsResult } from "@multica/core/types";
import { renderWithI18n } from "../../test/i18n";

let discovery: () => Promise<RuntimeModelsResult>;

vi.mock("@multica/core/runtimes", async () => {
  const actual =
    await vi.importActual<typeof import("@multica/core/runtimes")>(
      "@multica/core/runtimes",
    );
  return {
    ...actual,
    runtimeModelsOptions: (runtimeId: string | null) => ({
      enabled: Boolean(runtimeId),
      queryKey: ["builder-setup-models", runtimeId],
      queryFn: () => discovery(),
    }),
    refreshRuntimeModels: vi.fn(),
  };
});

vi.mock("../components/runtime-picker", () => ({
  RuntimePicker: () => <div data-testid="runtime-picker" />,
}));

import { BuilderSetup } from "./builder-conversation";

const RUNTIME = {
  id: "runtime-1",
  workspace_id: "workspace-1",
  daemon_id: "daemon-1",
  name: "Codex laptop",
  runtime_mode: "local",
  provider: "codex",
  launch_header: "",
  status: "online",
  device_info: "",
  metadata: {},
  owner_id: "user-1",
  visibility: "private",
  last_seen_at: null,
  created_at: "2026-10-21T00:00:00Z",
  updated_at: "2026-10-21T00:00:00Z",
} as RuntimeDevice;

const DRAFT: AgentDraft = {
  name: "Adaptive agent",
  description: "",
  instructions: "",
  conversationStarters: [],
  avatarUrl: null,
  qoderAgentId: "",
  runtimeId: RUNTIME.id,
  model: "old-model",
  thinkingLevel: "_adapt",
  serviceTier: "",
  skillIds: new Set(),
  permissionScope: "private",
  memberIds: new Set(),
  teamIds: new Set(),
};

function renderSetup(onChange = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <BuilderSetup
        draft={DRAFT}
        onChange={onChange}
        runtimes={[RUNTIME]}
        runtimesLoading={false}
        members={[]}
        currentUserId="user-1"
        selectedRuntime={RUNTIME}
        starting={false}
        error={null}
        onStart={vi.fn()}
        connectRuntimeHref="/connect"
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe("BuilderSetup adaptive model changes", () => {
  beforeEach(() => {
    discovery = async () => ({
      supported: true,
      models: [
        {
          id: "enough-candidates",
          label: "Enough candidates",
          thinking: {
            supported_levels: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        },
        {
          id: "one-candidate",
          label: "One candidate",
          thinking: {
            supported_levels: [
              { value: "auto", label: "Auto" },
              { value: "high", label: "High" },
            ],
          },
        },
      ],
    });
  });

  afterEach(cleanup);

  it("keeps Adapt only when the selected model still has enough candidates", async () => {
    const { onChange } = renderSetup();
    const open = () =>
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(
          '[data-slot="popover-trigger"]',
        )!,
      );

    open();
    fireEvent.click(await screen.findByText("Enough candidates"));
    expect(onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        model: "enough-candidates",
        thinkingLevel: "_adapt",
      }),
    );

    open();
    fireEvent.click(await screen.findByText("One candidate"));
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        model: "one-candidate",
        thinkingLevel: "",
      }),
    );
  });
});
