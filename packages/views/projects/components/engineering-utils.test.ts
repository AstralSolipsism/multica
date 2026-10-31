// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { EngineeringConfig, IssueGraphNode } from "@multica/core/api";
import type { Member, Project, TimelineEntry } from "@multica/core/types";
import { engineeringPermissions, engineeringStageTitles, selectEngineeringComment, summarizeEngineeringStages } from "./engineering-utils";

const comment = (id: string, content: string, createdAt: string, parentId: string | null = null): TimelineEntry => ({
  id, type: "comment", actor_type: "member", actor_id: "user-1", created_at: createdAt, content, parent_id: parentId,
});
const config = (deciderMemberIds: string[] = []) => ({ deciderMemberIds }) as EngineeringConfig;
const members = [
  { user_id: "owner-1", role: "owner" },
  { user_id: "member-1", role: "member" },
  { user_id: "lead-1", role: "member" },
] as Member[];

describe("engineeringStageTitles", () => {
  it("parses localized stage anchors and keeps the first title per stage", () => {
    const titles = engineeringStageTitles("### [Stage-1] 需求探索\ntext\n### [Stage-3] 切片开发\n### [Stage-3] 重复标题\n### [Rule-2] 不相关");
    expect([...titles.entries()]).toEqual([[1, "需求探索"], [3, "切片开发"]]);
  });
});

describe("selectEngineeringComment", () => {
  it("selects the newest root A+B comment by its first non-empty line", () => {
    const entries = [
      comment("old", "需要你定 1 件事\nold", "2026-01-01T00:00:00Z"),
      comment("reply", "需要你定 9 件事\nreply", "2026-01-03T00:00:00Z", "old"),
      comment("new", "\n需要你定 2 件事\nnew", "2026-01-02T00:00:00Z"),
    ];
    expect(selectEngineeringComment(entries)?.id).toBe("new");
  });

  it("falls back to the newest timeline comment when no root card exists", () => {
    const entries = [comment("old", "plain", "2026-01-01T00:00:00Z"), comment("new", "latest reply", "2026-01-02T00:00:00Z", "old")];
    expect(selectEngineeringComment(entries)?.id).toBe("new");
    expect(selectEngineeringComment([])).toBeNull();
  });
});

describe("engineeringPermissions", () => {
  it("includes admins and the human project lead by default", () => {
    const project = { lead_type: "member", lead_id: "lead-1" } as Project;
    expect(engineeringPermissions("lead-1", members, project, config())).toEqual({ isAdmin: false, isDecider: true, deciderIds: ["lead-1", "owner-1"] });
    expect(engineeringPermissions("member-1", members, project, config()).isDecider).toBe(false);
  });

  it("uses the explicit decider list while retaining admins", () => {
    const result = engineeringPermissions("member-1", members, undefined, config(["member-1"]));
    expect(result).toEqual({ isAdmin: false, isDecider: true, deciderIds: ["member-1", "owner-1"] });
    expect(engineeringPermissions("lead-1", members, undefined, config(["member-1"])).isDecider).toBe(false);
  });
});

describe("summarizeEngineeringStages", () => {
  it("groups open and closed tasks by stage without hiding blockers", () => {
    const nodes = [
      { id: "1", stage: 1, statusCategory: "done", status: "done" },
      { id: "2", stage: 1, statusCategory: "started", status: "blocked" },
      { id: "3", stage: null, statusCategory: "unstarted", status: "todo" },
    ] as IssueGraphNode[];
    const groups = summarizeEngineeringStages(nodes);
    expect(groups[0]).toMatchObject({ stage: 1, total: 2, closed: 1, blocked: 1 });
    expect(groups[0]?.open).toHaveLength(1);
    expect(groups[1]).toMatchObject({ stage: null, total: 1, closed: 0, blocked: 0 });
  });
});
