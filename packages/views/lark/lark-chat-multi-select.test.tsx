// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import type { ReactElement } from "react";
import { useState } from "react";
import { renderWithI18n } from "../test/i18n";

import { LarkChatMultiSelect, type LarkChatSelection } from "./index";

const capsMock = vi.hoisted(() => vi.fn());
const chatsMock = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getLarkTargetCapabilities: (...args: unknown[]) => capsMock(...args),
      listLarkTargetChats: (...args: unknown[]) => chatsMock(...args),
    },
  };
});

const CAPS = {
  chat_list_supported: true,
  message_anchor_list_supported: true,
  region: "feishu",
  scope_status: "not_checked",
  max_chat_page_size: 100,
  max_message_page_size: 50,
};

function chat(id: string, name: string) {
  return { chat_id: id, name, description: "", avatar: "", external: false, chat_status: "normal" };
}

function renderMulti(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function Harness({ initial = [], otherCount = 0, max = 50, onChange }: {
  initial?: LarkChatSelection[];
  otherCount?: number;
  max?: number;
  onChange?: (next: LarkChatSelection[]) => void;
}) {
  const [selected, setSelected] = useState<LarkChatSelection[]>(initial);
  return (
    <LarkChatMultiSelect
      wsId="ws-1"
      installationId="inst-1"
      selected={selected}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
      max={max}
      otherCount={otherCount}
      fallback={<textarea aria-label="legacy groups" />}
    />
  );
}

beforeEach(() => {
  capsMock.mockReset().mockResolvedValue(CAPS);
  chatsMock.mockReset().mockResolvedValue({
    items: [chat("oc_a", "Alpha"), chat("oc_b", "Beta")],
    has_more: false,
    next_cursor: "",
  });
});

afterEach(() => cleanup());

describe("LarkChatMultiSelect", () => {
  it("adds and removes groups as chips, deduplicated by chat_id", async () => {
    const onChange = vi.fn();
    renderMulti(<Harness onChange={onChange} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /add groups/i }));
    const alpha = await screen.findByRole("checkbox", { name: /Alpha/ });
    await user.click(alpha);
    // Toggling the same row again removes it instead of duplicating.
    await user.click(await screen.findByRole("checkbox", { name: /Alpha/ }));
    await user.click(screen.getByRole("checkbox", { name: /Beta/ }));

    const added = onChange.mock.calls.map((c) => (c[0] as LarkChatSelection[]).map((s) => s.chat_id));
    expect(added).toEqual([["oc_a"], [], ["oc_b"]]);
  });

  it("renders saved grants as removable chips even before the list loads", async () => {
    renderMulti(<Harness initial={[{ chat_id: "oc_saved", name: "" }]} />);
    expect(await screen.findByText("oc_saved")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /remove oc_saved/i }));
    expect(screen.queryByText("oc_saved")).not.toBeInTheDocument();
  });

  it("caps the total at the conversation limit, counting direct chats too", async () => {
    renderMulti(<Harness otherCount={49} max={50} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /add groups/i }));
    await user.click(await screen.findByRole("checkbox", { name: /Alpha/ }));

    // At 50 total: the remaining unselected row is disabled and the hint shows.
    expect(await screen.findByText(/at most 50 conversations/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Beta/ })).toBeDisabled();
    // Removing a selection re-enables adding.
    await user.click(screen.getByRole("button", { name: /remove alpha/i }));
    expect(screen.getByRole("checkbox", { name: /Beta/ })).toBeEnabled();
  });

  it("keeps the legacy textarea as fallback when discovery is unsupported", async () => {
    capsMock.mockRejectedValue(new ApiError("Not Found", 404, "Not Found"));
    renderMulti(<Harness />);
    expect(await screen.findByLabelText("legacy groups")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add groups/i })).not.toBeInTheDocument();
  });
});
