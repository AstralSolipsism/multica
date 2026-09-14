// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import type { ReactElement } from "react";
import { useState } from "react";
import { renderWithI18n } from "../test/i18n";

import { LarkPrivateChatSelect, type LarkChatSelection } from "./index";

const capsMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("@multica/core/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getLarkTargetCapabilities: (...args: unknown[]) => capsMock(...args),
      listLarkPrivateChatCandidates: (...args: unknown[]) => listMock(...args),
      confirmLarkPrivateChatCandidates: (...args: unknown[]) => confirmMock(...args),
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
  private_chat_candidates_supported: true,
  private_chat_identity_lookup_supported: true,
  max_private_chat_candidates: 50,
  private_chat_candidate_retention_seconds: 604800,
};

function candidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    chat_id: `oc_chat_${id}`,
    chat_type: "p2p",
    sender: { type: "user", id: `ou_${id}`, id_type: "open_id" },
    display_name: "",
    identity_status: "id_only",
    authorization_status: "pending",
    first_seen_at: "2026-09-13T12:00:00Z",
    last_seen_at: "2026-09-13T12:00:00Z",
    expires_at: "2026-09-20T12:00:00Z",
    ...overrides,
  };
}

const grant = {
  id: "01994566-7cc0-7000-8000-0000000000ff",
  authorized_by: "01994566-7cc0-7000-8000-0000000000ee",
  scope: "workspace",
  chats: [{ chat_id: "oc_chat_c1", chat_type: "p2p" }],
};

function renderSelect(ui: ReactElement) {
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
    <LarkPrivateChatSelect
      wsId="ws-1"
      installationId="inst-1"
      selected={selected}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
      max={max}
      otherCount={otherCount}
      fallback={<textarea aria-label="legacy directs" />}
    />
  );
}

beforeEach(() => {
  capsMock.mockReset().mockResolvedValue(CAPS);
  listMock.mockReset().mockResolvedValue({
    items: [
      candidate("c1", { display_name: "Alice", identity_status: "name_available" }),
      candidate("c2"),
      candidate("c3", { display_name: "Carol", identity_status: "name_available", authorization_status: "authorized" }),
    ],
    max_candidates: 50,
    retention_seconds: 604800,
  });
  confirmMock.mockReset().mockResolvedValue(grant);
});

afterEach(() => cleanup());

describe("LarkPrivateChatSelect", () => {
  it("lists discovered chats with names, badges and times; authorized rows are informational", async () => {
    renderSelect(<Harness />);

    // Pending candidate with a name: checkbox option with the pending badge.
    expect(await screen.findByRole("checkbox", { name: /Alice/ })).toBeInTheDocument();
    expect(screen.getAllByText("Pending").length).toBe(2);
    // id_only candidate: explicit missing-name state, never a fabricated name,
    // plus the correlation hint (IDs + last-seen time).
    expect(screen.getByText("Name unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Match the chat and user IDs/i)).toBeInTheDocument();
    // Authorized candidate: badge, but no checkbox — revocation stays on the
    // chips + the form's full-list save.
    expect(screen.getByText("Carol")).toBeInTheDocument();
    expect(screen.getByText("Authorized")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Carol/ })).not.toBeInTheDocument();
    // Times render for recognition.
    expect(screen.getAllByText(/Last message/).length).toBe(3);
  });

  it("shows actionable steps and the discovery-only note when nothing was discovered", async () => {
    listMock.mockResolvedValue({ items: [], max_candidates: 50, retention_seconds: 604800 });
    renderSelect(<Harness />);

    expect(await screen.findByText("No private chats discovered yet")).toBeInTheDocument();
    expect(screen.getByText(/send any message, then come back and refresh/i)).toBeInTheDocument();
    // Sending a message is discovery-only; authorization is still required.
    expect(screen.getByText(/grants no access by itself/i)).toBeInTheDocument();
    expect(screen.getByText(/Sending a message only makes the conversation discoverable/i)).toBeInTheDocument();
  });

  it("refreshes the candidate list from the explicit refresh entry", async () => {
    renderSelect(<Harness />);
    await screen.findByRole("checkbox", { name: /Alice/ });
    expect(listMock).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("confirms selected candidates via the confirm endpoint and unions them into the draft", async () => {
    const onChange = vi.fn();
    renderSelect(<Harness onChange={onChange} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
    await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));

    await waitFor(() =>
      expect(confirmMock).toHaveBeenCalledWith("ws-1", "inst-1", ["c1"]));
    // The confirmed chat joins the draft (with its display name) so the next
    // full-list save cannot silently drop it.
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([{ chatId: "oc_chat_c1", name: "Alice" }]));
    expect(await screen.findByText(/Authorization saved/)).toBeInTheDocument();
    // Earlier messages are not replayed — the note says so.
    expect(screen.getByText(/earlier messages are not replayed/i)).toBeInTheDocument();
  });

  it("refreshes and clears the stale selection on a 410 candidate_unavailable", async () => {
    confirmMock.mockRejectedValue(
      new ApiError("gone", 410, "Gone", { error: "x", code: "lark_private_chat_candidate_unavailable" }),
    );
    renderSelect(<Harness />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
    await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));

    expect(await screen.findByText(/expired or was replaced.*refreshed/i)).toBeInTheDocument();
    // The list was re-read and the dead candidate UUID is not retried.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /Authorize selected \(0\)/ })).toBeDisabled();
  });

  it("keeps the selection and explains invocation denial without a raw-ID bypass", async () => {
    confirmMock.mockRejectedValue(
      new ApiError("denied", 403, "Forbidden", { error: "x", code: "lark_conversation_invocation_denied" }),
    );
    renderSelect(<Harness />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
    await user.click(screen.getByRole("button", { name: /Authorize selected \(1\)/ }));

    expect(await screen.findByText(/also requires permission to invoke this agent/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Alice/ })).toBeChecked();
    expect(screen.queryByLabelText("legacy directs")).not.toBeInTheDocument();
  });

  it("caps confirmations at the conversation limit, counting groups too", async () => {
    renderSelect(<Harness otherCount={49} max={50} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("checkbox", { name: /Alice/ }));
    // 49 + 1 = 50: the remaining pending row is disabled and the hint shows.
    expect(await screen.findByText(/At most 50 conversations/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Name unavailable/ })).toBeDisabled();
  });

  it("keeps saved chats as removable chips even when they are not candidates", async () => {
    renderSelect(<Harness initial={[{ chatId: "oc_saved", name: "" }]} />);

    expect(await screen.findByText("oc_saved")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /remove oc_saved/i }));
    expect(screen.queryByText("oc_saved")).not.toBeInTheDocument();
  });

  it("resolves saved chip names from the candidate list", async () => {
    renderSelect(<Harness initial={[{ chatId: "oc_chat_c1", name: "" }]} />);
    expect(await screen.findByRole("button", { name: /remove Alice/i })).toBeInTheDocument();
  });

  it("falls back to manual entry only when the server cannot discover private chats", async () => {
    capsMock.mockResolvedValue({ ...CAPS, private_chat_candidates_supported: undefined });
    renderSelect(<Harness initial={[{ chatId: "oc_saved", name: "" }]} />);

    expect(await screen.findByText(/cannot discover private chats yet/i)).toBeInTheDocument();
    expect(screen.getByLabelText("legacy directs")).toBeInTheDocument();
    expect(screen.getByText("oc_saved")).toBeInTheDocument();
  });

  it("explains the required role on 403 without a manual-entry bypass", async () => {
    capsMock.mockRejectedValue(
      new ApiError("forbidden", 403, "Forbidden", { error: "x", code: "lark_discovery_forbidden" }),
    );
    renderSelect(<Harness initial={[{ chatId: "oc_saved", name: "" }]} />);

    expect(await screen.findByText(/requires the bot's agent owner or a workspace admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("legacy directs")).not.toBeInTheDocument();
    expect(screen.getByText("oc_saved")).toBeInTheDocument();
  });

  it("surfaces list errors with a retry instead of the empty state", async () => {
    listMock.mockRejectedValue(
      new ApiError("conflict", 409, "Conflict", { error: "x", code: "lark_installation_inactive" }),
    );
    renderSelect(<Harness />);

    expect(await screen.findByText(/installation is inactive/i)).toBeInTheDocument();
    expect(screen.queryByText("No private chats discovered yet")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});
