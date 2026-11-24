// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { projectWikiActivityInfiniteOptions } from "./engineering-queries";

const second = "2026-11-24T08:00:00";
function micros(timestamp: string) {
  const [date, fraction = ""] = timestamp.slice(0, -1).split(".");
  return Date.parse(date + "Z") * 1000 + Number(fraction.padEnd(6, "0"));
}

function bundle(at: string, version: number, count = 50) {
  return Array.from({ length: count }, (_, i) => ({
    pageId: "page-" + i, slug: "page-" + i, title: "page-" + i,
    number: version, createdAt: second + at + "Z", kind: "archive",
    createdByType: "member", createdById: "owner", sourceIssueId: null, changeSummary: "",
  }));
}

function fixture(rows: ReturnType<typeof bundle>, pages: { id: string; title: string; slug: string; createdAt?: string }[]) {
  const history = vi.fn(async (_ws, _project, slug: string) => ({
    revisions: rows.filter((row) => row.slug === slug).map((row) => ({
      ...row, revisionKind: row.kind, revisionNumber: row.number,
    })),
    hasMore: false, nextBefore: null,
  }));
  const activity = vi.fn(async (_ws, _project, { before, limit }: { before?: string; limit: number }) => ({
    items: rows.filter((row) => !before || micros(row.createdAt) < micros(before)).slice(0, limit),
  }));
  setApiInstance({ getProjectWikiActivity: activity, getProjectWikiPageHistory: history } as unknown as ApiClient);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const options = projectWikiActivityInfiniteOptions("workspace", "project", 50, pages);
  return { advance: () => client.fetchInfiniteQuery({ ...options, pages: 12 }), history, activity };
}

it("r3: saturated groups within one millisecond can advance to older history", async () => {
  const newer = bundle(".1239", 3);
  const older = bundle(".1231", 2);
  const earliest = bundle(".122", 1, 1);
  const pages = newer.map((row) => ({ id: row.pageId, title: row.title, slug: row.slug }));
  const { advance, activity } = fixture([...newer, ...older, ...earliest], pages);
  const result = await advance();
  const unique = new Set(result.pages.flatMap((page) => page?.items.map((row) => row.pageId + ":" + row.number) ?? []));
  expect(unique.size).toBe(101);
  expect(activity.mock.calls.map(([, , { before }]) => before)).toEqual([
    undefined, second + ".123901Z", second + ".1239Z", second + ".123101Z", second + ".1231Z",
  ]);
});

it("r3: fallback skips pages created after the target transaction", async () => {
  const rows = bundle(".123", 2);
  const pages = Array.from({ length: 100 }, (_, i) => ({
    id: "page-" + i, slug: "page-" + i, title: "page-" + i,
    createdAt: i < 50 ? "2026-11-23T00:00:00Z" : new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString(),
  }));
  const creations = pages.slice(50).reverse().map((page) => ({
    ...rows[0]!, pageId: page.id, slug: page.slug, title: page.title, createdAt: page.createdAt,
    kind: "create", number: 1,
  }));
  const inventory = pages.map((page, index) => index >= 75 ? { ...page, createdAt: "" } : page);
  const { advance, history } = fixture([...creations.slice(0, 25), ...rows], inventory);
  await advance();
  expect(history).toHaveBeenCalledTimes(50);
  const unrelated = history.mock.calls.filter(([, , slug]) => Number(slug.slice(5)) >= 50);
  expect(unrelated).toHaveLength(0);
});

it("r3: page history compares RFC3339Nano timestamps in chronological order", async () => {
  const timestamp = second + ".12Z";
  const entry = (number: number, createdAt: string) => ({
    revisionNumber: number, createdAt, revisionKind: "archive", createdByType: "member",
    createdById: "owner", changeSummary: "", sourceIssueId: null,
  });
  const newer = Array.from({ length: 200 }, (_, i) => entry(201 - i,
    i === 199 ? second + ".123Z" : new Date(Date.parse(second + "Z") + (200 - i) * 1000).toISOString(),
  ));
  const history = vi.fn(async (_ws, _project, _slug, { before }) => before
    ? { revisions: [entry(1, timestamp)], hasMore: false, nextBefore: null }
    : { revisions: newer, hasMore: true, nextBefore: 2 });
  setApiInstance({ getProjectWikiPageHistory: history } as unknown as ApiClient);
  const options = projectWikiActivityInfiniteOptions("ws", "project", 50, [
    { id: "missing", title: "missing", slug: "missing" },
  ]);
  const result = await new QueryClient().fetchInfiniteQuery({
    ...options, initialPageParam: { backfillAt: timestamp }, pages: 1,
  });
  expect(result.pages[0]?.items.map((r) => r.number)).toEqual([1]);
});
