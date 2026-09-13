// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import type { LarkChatsPage } from "@multica/core/types";
import type { ReactElement } from "react";
import { renderWithI18n } from "../test/i18n";

import { LarkChatPicker, type LarkChatSelection } from "./index";
import { useState } from "react";

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

function chat(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    chat_id: id,
    name,
    description: "",
    avatar: "",
    external: false,
    chat_status: "normal",
    ...extra,
  };
}

function page(items: ReturnType<typeof chat>[], hasMore = false, cursor = ""): LarkChatsPage {
  return { items, has_more: hasMore, next_cursor: cursor };
}

function renderPicker(ui: ReactElement, qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Controlled harness mirroring how the route editors hold the selection. */
function Harness({ installationId = "inst-1" }: { installationId?: string }) {
  const [value, setValue] = useState<LarkChatSelection | null>(null);
  return (
    <LarkChatPicker
      wsId="ws-1"
      installationId={installationId}
      value={value}
      onChange={setValue}
      fallback={<input placeholder="oc_..." aria-label="manual chat id" />}
    />
  );
}

beforeEach(() => {
  capsMock.mockReset().mockResolvedValue(CAPS);
  chatsMock.mockReset();
});

afterEach(() => cleanup());

describe("LarkChatPicker", () => {
  it("lists joined groups with search, selection and clear — no raw ID entry needed", async () => {
    chatsMock.mockResolvedValue(page([
      chat("oc_a", "Release", { description: "Team A" }),
      chat("oc_b", "Release", { description: "Team B", external: true }),
    ]));
    renderPicker(<Harness />);
    const user = userEvent.setup();

    // Same-named groups both render, each carrying its disambiguating ID
    // suffix; the external group is badged.
    const options = await screen.findAllByRole("option", { name: /Release/ });
    expect(options).toHaveLength(2);
    expect(screen.getByText("Team A")).toBeInTheDocument();
    expect(screen.getByText("External")).toBeInTheDocument();

    await user.click(options[1]!);
    expect(await screen.findByText("Selected group")).toBeInTheDocument();
    // The chip shows the picked name; the raw ID stays one toggle away.
    const chip = screen.getByText("Selected group").parentElement!;
    expect(chip).toHaveTextContent("Release");

    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    await waitFor(() =>
      expect(screen.queryByText("Selected group")).not.toBeInTheDocument());
  });

  it("filters by name through the server query, debounced", async () => {
    chatsMock.mockImplementation((_ws: string, _inst: string, opts: { q?: string }) =>
      Promise.resolve(
        opts?.q === "release" ? page([chat("oc_a", "Release")]) : page([chat("oc_x", "Other")]),
      ));
    renderPicker(<Harness />);
    const user = userEvent.setup();

    expect(await screen.findByRole("option", { name: /Other/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search groups"), "Release");
    await waitFor(() =>
      expect(chatsMock).toHaveBeenCalledWith("ws-1", "inst-1", expect.objectContaining({ q: "release" })));
    expect(await screen.findByRole("option", { name: /Release/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Other/ })).not.toBeInTheDocument();
  });

  it("pages manually with the opaque cursor and dedupes rows across pages", async () => {
    chatsMock.mockImplementation((_ws: string, _inst: string, opts: { cursor?: string }) => {
      if (opts?.cursor === "cur-1") return Promise.resolve(page([chat("oc_a", "Dup"), chat("oc_b", "Second")]));
      return Promise.resolve(page([chat("oc_a", "First")], true, "cur-1"));
    });
    renderPicker(<Harness />);
    const user = userEvent.setup();

    expect(await screen.findByRole("option", { name: /First/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /load more groups/i }));

    await waitFor(() =>
      expect(chatsMock).toHaveBeenCalledWith("ws-1", "inst-1", expect.objectContaining({ cursor: "cur-1" })));
    expect(await screen.findByRole("option", { name: /Second/ })).toBeInTheDocument();
    // oc_a appeared on both pages but renders once.
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("auto-continues empty filtered pages before concluding no matches", async () => {
    let calls = 0;
    chatsMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(page([], true, "c1"));
      if (calls === 2) return Promise.resolve(page([], true, "c2"));
      return Promise.resolve(page([]));
    });
    renderPicker(<Harness />);

    // No "no results" yet while pages keep coming; the hook walks on.
    await waitFor(() => expect(chatsMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(/has not joined any group yet/)).toBeInTheDocument();
  });

  it("surfaces a permission error with retry instead of an empty list", async () => {
    chatsMock.mockRejectedValue(
      new ApiError("forbidden", 403, "Forbidden", { error: "x", code: "lark_discovery_permission_denied" }),
    );
    renderPicker(<Harness />);

    expect(await screen.findByText(/missing the group or message read scope/i)).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();

    chatsMock.mockResolvedValue(page([chat("oc_a", "Back")]));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("option", { name: /Back/ })).toBeInTheDocument();
  });

  it("restarts from page one when the cursor expires mid-listing", async () => {
    let calls = 0;
    chatsMock.mockImplementation((_ws: string, _inst: string, opts: { cursor?: string }) => {
      calls += 1;
      if (opts?.cursor === "cur-1") {
        return Promise.reject(
          new ApiError("expired", 400, "Bad Request", { error: "x", code: "lark_discovery_invalid_cursor" }),
        );
      }
      return Promise.resolve(page([chat("oc_a", "First")], calls === 1, calls === 1 ? "cur-1" : ""));
    });
    renderPicker(<Harness />);
    const user = userEvent.setup();

    expect(await screen.findByRole("option", { name: /First/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /load more groups/i }));
    expect(await screen.findByText(/listing session expired/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reload from the first page/i }));
    // Fresh sequence: a bare first-page request, no dead cursor.
    await waitFor(() =>
      expect(chatsMock).toHaveBeenCalledWith("ws-1", "inst-1", expect.objectContaining({ cursor: undefined })));
  });

  it("keeps a saved target visible and flags it when the bot no longer joins that group", async () => {
    chatsMock.mockResolvedValue(page([chat("oc_other", "Other")]));
    renderPicker(
      <LarkChatPicker
        wsId="ws-1"
        installationId="inst-1"
        value={{ chatId: "oc_saved", name: "" }}
        onChange={() => {}}
        fallback={<input aria-label="manual" />}
      />,
    );

    // The raw saved ID stays as the chip (no resolved name)…
    expect(await screen.findByText("oc_saved")).toBeInTheDocument();
    // …and once the full list confirms it is gone, the stale note appears.
    expect(await screen.findByText(/not among the groups this bot has joined/i)).toBeInTheDocument();
  });

  it("falls back to manual ID entry on a pre-discovery server (uncoded 404)", async () => {
    capsMock.mockRejectedValue(new ApiError("Not Found", 404, "Not Found"));
    renderPicker(<Harness />);

    expect(await screen.findByLabelText("manual chat id")).toBeInTheDocument();
    expect(screen.getByText(/cannot browse groups or messages yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("falls back to manual ID entry when the transport reports discovery unsupported", async () => {
    capsMock.mockResolvedValue({ ...CAPS, chat_list_supported: false });
    renderPicker(<Harness />);

    expect(await screen.findByLabelText("manual chat id")).toBeInTheDocument();
  });

  it("explains the required management role on 403 and offers NO manual-entry bypass (OL-72 contract)", async () => {
    capsMock.mockRejectedValue(
      new ApiError("forbidden", 403, "Forbidden", { error: "x", code: "lark_discovery_forbidden" }),
    );
    renderPicker(<Harness />);

    expect(await screen.findByText(/requires the bot's agent owner or a workspace admin/i)).toBeInTheDocument();
    // Forbidden is not a fallback case: no raw-ID input, no listbox.
    expect(screen.queryByLabelText("manual chat id")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The copy must not suggest bypassing discovery with a raw ID.
    expect(screen.queryByText(/enter the ID manually/i)).not.toBeInTheDocument();
  });

  it("keeps the saved target visible (with its save semantics) under 403", async () => {
    capsMock.mockRejectedValue(
      new ApiError("forbidden", 403, "Forbidden", { error: "x", code: "lark_discovery_forbidden" }),
    );
    renderPicker(
      <LarkChatPicker
        wsId="ws-1"
        installationId="inst-1"
        value={{ chatId: "oc_saved", name: "Saved Group" }}
        onChange={() => {}}
        fallback={<input aria-label="manual chat id" />}
      />,
    );

    expect(await screen.findByText("Saved Group")).toBeInTheDocument();
    expect(screen.getByText(/requires the bot's agent owner or a workspace admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("manual chat id")).not.toBeInTheDocument();
  });

  it("switching bots cannot be polluted by the previous bot's in-flight pages", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveOld: ((p: LarkChatsPage) => void) | null = null;
    chatsMock.mockImplementation((_ws: string, inst: string) => {
      if (inst === "inst-1") {
        return new Promise<LarkChatsPage>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve(page([chat("oc_new", "New Bot Group")]));
    });
    const { rerender } = renderPicker(<Harness installationId="inst-1" />, qc);

    // Switch bots before the old request resolves…
    rerender(
      <QueryClientProvider client={qc}>
        <Harness installationId="inst-2" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("option", { name: /New Bot Group/ })).toBeInTheDocument();

    // …then the stale response lands; the view must not show it.
    (resolveOld as ((p: LarkChatsPage) => void) | null)?.(page([chat("oc_stale", "Stale Group")]));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("option", { name: /Stale Group/ })).not.toBeInTheDocument();
  });
});
