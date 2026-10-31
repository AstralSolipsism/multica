// @vitest-environment node
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { ChatMessage } from "../types/chat";
import { chatMessagesPageOptions } from "./queries";
import { invalidateChatMessageQueries } from "../realtime/use-realtime-sync";

vi.mock("../api", () => ({ api: { listChatMessagesPage: vi.fn() } }));
afterEach(() => vi.clearAllMocks());

function message(index: number): ChatMessage {
  return {
    id: String(index).padStart(4, "0"), chat_session_id: "session", role: "assistant",
    content: `answer ${index}`, task_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  };
}

async function history() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let rows = Array.from({ length: 12 }, (_, i) => message(i));
  const request = vi.mocked(api.listChatMessagesPage).mockImplementation(async (_, options) => {
    const candidates = rows.filter((row) => !options?.before || row.id < options.before.id);
    const messages = candidates.slice(-(options?.limit ?? 50));
    const hasMore = candidates.length > messages.length;
    const first = messages[0];
    return {
      messages, limit: options?.limit ?? 50, has_more: hasMore,
      next_cursor: hasMore && first ? { id: first.id, created_at: first.created_at } : null,
    };
  });
  const observer = new InfiniteQueryObserver(qc, chatMessagesPageOptions("session", 3));
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch();
  await observer.fetchNextPage();
  return {
    qc, observer, request,
    change: (next: ChatMessage[]) => { rows = next; },
    rows: () => rows,
    messages: () => observer.getCurrentResult().data!.pages.slice().reverse().flatMap((page) => page.messages),
    close: () => { unsubscribe(); qc.clear(); },
  };
}

describe("chat history pagination during realtime refresh (OL-1166)", () => {
  it("keeps the loaded oldest row when realtime invalidates multiple pages after new turns", async () => {
    const h = await history();
    expect(h.messages().map((row) => row.id)).toEqual([6, 7, 8, 9, 10, 11].map((i) => message(i).id));
    h.change([...h.rows(), ...[12, 13, 14, 15].map(message)]);
    invalidateChatMessageQueries(h.qc, "session");
    await vi.waitFor(() => expect(h.observer.getCurrentResult().isFetching).toBe(false));
    const result = h.messages();
    expect(result[0]?.id).toBe(message(6).id);
    expect(result.at(-1)?.id).toBe(message(15).id);
    expect(new Set(result.map((row) => row.id)).size).toBe(result.length);
    await h.observer.fetchNextPage();
    expect(h.messages()[0]?.id).toBe(message(3).id);
    h.close();
  });

  it("does not restore deleted rows or stale content while retaining the reading window", async () => {
    const h = await history();
    h.change([...h.rows().filter((row) => row.id !== message(9).id).map((row) => (
      row.id === message(10).id ? { ...row, content: "redacted" } : row
    )), message(12)]);
    await h.observer.refetch();
    expect(h.messages().some((row) => row.id === message(9).id)).toBe(false);
    expect(h.messages().find((row) => row.id === message(10).id)?.content).toBe("redacted");
    expect(h.messages().some((row) => row.id === message(6).id)).toBe(true);
    h.close();
  });

  it("does not issue extra requests when no new messages changed the window", async () => {
    const h = await history();
    h.request.mockClear();
    await h.observer.refetch();
    expect(h.request).toHaveBeenCalledTimes(2);
    h.close();
  });

  it("terminates at history end if the old boundary no longer exists", async () => {
    const h = await history();
    h.change([message(20)]);
    await h.observer.refetch();
    expect(h.messages()).toEqual([message(20)]);
    expect(h.observer.getCurrentResult().hasNextPage).toBe(false);
    h.close();
  });
});
