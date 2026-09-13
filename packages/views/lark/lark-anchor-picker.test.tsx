// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import type { LarkAnchorsPage } from "@multica/core/types";
import type { ReactElement } from "react";
import { renderWithI18n } from "../test/i18n";

import { LarkAnchorPicker, type LarkAnchorSelection } from "./index";
import { useState } from "react";

const capsMock = vi.hoisted(() => vi.fn());
const anchorsMock = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getLarkTargetCapabilities: (...args: unknown[]) => capsMock(...args),
      listLarkMessageAnchors: (...args: unknown[]) => anchorsMock(...args),
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

function anchor(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    message_id: id,
    chat_id: "oc_a",
    message_type: "text",
    summary,
    create_time: "1700000000000",
    sender: { type: "user", id: "ou_1", id_type: "open_id" },
    ...extra,
  };
}

function page(items: ReturnType<typeof anchor>[], hasMore = false, cursor = ""): LarkAnchorsPage {
  return { items, has_more: hasMore, next_cursor: cursor };
}

function renderAnchor(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function Harness({ chatId = "oc_a" }: { chatId?: string }) {
  const [value, setValue] = useState<LarkAnchorSelection | null>(null);
  return (
    <LarkAnchorPicker
      wsId="ws-1"
      installationId="inst-1"
      chatId={chatId}
      value={value}
      onChange={setValue}
      fallback={<input placeholder="om_..." aria-label="manual message id" />}
    />
  );
}

beforeEach(() => {
  capsMock.mockResolvedValue(CAPS);
  anchorsMock.mockReset();
});

afterEach(() => cleanup());

describe("LarkAnchorPicker", () => {
  it("asks for a group first and issues no request until one is selected", async () => {
    renderAnchor(<Harness chatId="" />);
    expect(await screen.findByText(/select a group above/i)).toBeInTheDocument();
    expect(anchorsMock).not.toHaveBeenCalled();
  });

  it("lists anchors with summary, localized time and sender; pick returns id + thread", async () => {
    anchorsMock.mockResolvedValue(page([
      anchor("om_new", "release ready", { thread_id: "omt_topic" }),
      anchor("om_old", "[Image]", {
        create_time: "1600000000000",
        sender: { type: "anonymous" },
      }),
    ]));
    renderAnchor(<Harness />);
    const user = userEvent.setup();

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    // Plain-text summary, sender label with id suffix, localized time.
    expect(screen.getByText("release ready")).toBeInTheDocument();
    expect(screen.getByText(/User · …/)).toBeInTheDocument();
    expect(screen.getByText(/Anonymous/)).toBeInTheDocument();

    let picked: LarkAnchorSelection | null = null;
    cleanup();
    renderAnchor(
      <LarkAnchorPicker
        wsId="ws-1"
        installationId="inst-1"
        chatId="oc_a"
        value={picked}
        onChange={(sel) => {
          picked = sel;
        }}
        fallback={<input aria-label="manual" />}
      />,
    );
    await user.click(await screen.findByRole("option", { name: /release ready/ }));
    expect(picked).toEqual({
      message_id: "om_new",
      summary: "release ready",
      thread_id: "omt_topic",
    });
  });

  it("never auto-selects the latest message — an empty pick stays empty", async () => {
    anchorsMock.mockResolvedValue(page([anchor("om_new", "latest")]));
    renderAnchor(<Harness />);
    expect(await screen.findByRole("option", { name: /latest/ })).toBeInTheDocument();
    expect(screen.queryByText("Selected anchor")).not.toBeInTheDocument();
  });

  it("pages earlier history with the opaque cursor", async () => {
    anchorsMock.mockImplementation((_ws: string, _inst: string, _chat: string, opts: { cursor?: string }) =>
      Promise.resolve(
        opts?.cursor === "c1" ? page([anchor("om_old", "older")]) : page([anchor("om_new", "newer")], true, "c1"),
      ));
    renderAnchor(<Harness />);
    const user = userEvent.setup();

    expect(await screen.findByRole("option", { name: /newer/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /load earlier messages/i }));
    await waitFor(() =>
      expect(anchorsMock).toHaveBeenCalledWith("ws-1", "inst-1", "oc_a", expect.objectContaining({ cursor: "c1" })));
    expect(await screen.findByRole("option", { name: /older/ })).toBeInTheDocument();
  });

  it("shows the empty state only after pagination finishes", async () => {
    anchorsMock.mockResolvedValue(page([]));
    renderAnchor(<Harness />);
    expect(await screen.findByText(/no recent messages in this group/i)).toBeInTheDocument();
  });

  it("surfaces chat_unavailable (bot not in group) with retry", async () => {
    anchorsMock.mockRejectedValue(
      new ApiError("gone", 404, "Not Found", { error: "x", code: "lark_discovery_chat_unavailable" }),
    );
    renderAnchor(<Harness />);
    expect(await screen.findByText(/bot is not a member/i)).toBeInTheDocument();
  });

  it("keeps the saved anchor visible and flags it when it left the recent history", async () => {
    anchorsMock.mockResolvedValue(page([anchor("om_other", "something")]));
    renderAnchor(
      <LarkAnchorPicker
        wsId="ws-1"
        installationId="inst-1"
        chatId="oc_a"
        value={{ message_id: "om_saved", summary: "" }}
        onChange={() => {}}
        fallback={<input aria-label="manual" />}
      />,
    );
    expect(await screen.findByText("om_saved")).toBeInTheDocument();
    expect(await screen.findByText(/not in the recent history/i)).toBeInTheDocument();
  });

  it("falls back to manual message ID entry when anchor listing is unsupported", async () => {
    capsMock.mockResolvedValue({ ...CAPS, message_anchor_list_supported: false });
    renderAnchor(<Harness />);
    expect(await screen.findByLabelText("manual message id")).toBeInTheDocument();
  });
});
