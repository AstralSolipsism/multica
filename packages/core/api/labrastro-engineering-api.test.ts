// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("sends exact reviewed revision IDs and workspace, and does not retry a conflict", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "candidate closed", code: "baseline_candidate_closed" }), { status: 409 }));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient("https://example.test");
  await expect(api.decideProjectBaseline("workspace", "project/id", "adopt", [{ revisionId: "reviewed", expectedAdoptedRevisionId: "base" }])).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://example.test/api/projects/project%2Fid/baseline/decisions");
  expect(new Headers(init.headers).get("X-Workspace-ID")).toBe("workspace");
  expect(JSON.parse(String(init.body))).toEqual({ action: "adopt", revisions: [{ revision_id: "reviewed", expected_adopted_revision_id: "base" }] });
});

it("returns null for malformed baseline responses through the installed client", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ engineering: null, chapters: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
  expect(await new ApiClient("https://example.test").getProjectEngineering("workspace", "project")).toBeNull();
});

it("sends stages as a replacement array and omits unspecified fields", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ engineering: { project_id: id, workspace_id: id, stages: [] } }))));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient("https://example.test");
  const stages = [{ stage: 9, title: "Release" }];
  await api.updateProjectEngineering(id, id, { stages, currentStage: 9 });
  await api.updateProjectEngineering(id, id, { stages: [] });
  await api.updateProjectEngineering(id, id, { modeSummary: "Iterate" });
  expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
    { stages, current_stage: 9 }, { stages: [] }, { mode_summary: "Iterate" },
  ]);
});

it("sends local section proposals and server-side compact reads", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}))));
  vi.stubGlobal("fetch", fetcher);
  const api = new ApiClient("https://example.test");
  await api.proposeProjectBaseline("workspace", "project", { chapter: "module:billing", chapterTitle: "Billing", section: "Pay", contentMarkdown: "Updated", changeSummary: "Edit", baseRevisionId: null });
  await api.proposeProjectBaseline("workspace", "project", { chapter: "module:billing", section: "Pay", deleteSection: true, contentMarkdown: "", changeSummary: "Remove", baseRevisionId: "base" });
  await api.getProjectBaselineIndex("workspace", "project");
  await api.getProjectBaselineSection("workspace", "project", "A & B", { chapter: "module:billing", candidate: true });
  const bodies = fetcher.mock.calls.slice(0,2).map((call) => JSON.parse(call[1].body));
  expect(bodies[0]).toMatchObject({ chapter: "module:billing", chapter_title: "Billing", section: "Pay", content_markdown: "Updated", base_revision_id: null });
  expect(bodies[1]).toMatchObject({ section: "Pay", delete_section: true, content_markdown: "", base_revision_id: "base" });
  expect(fetcher.mock.calls[2]?.[0]).toBe("https://example.test/api/projects/project/baseline?index=true");
  const url = new URL(fetcher.mock.calls[3]?.[0]);
  expect(url.searchParams.get("section")).toBe("A & B");
  expect(url.searchParams.get("chapter")).toBe("module:billing");
  expect(url.searchParams.get("candidate")).toBe("true");
  expect(new Headers(fetcher.mock.calls[3]?.[1].headers).get("X-Workspace-ID")).toBe("workspace");
});
