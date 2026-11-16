import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import type { Agent, AgentSkillSummary, MemberWithUser, Squad } from "@multica/core/types";
import { createEditorExtensions } from "../../editor/extensions";
import { resolveIssueSlashSkills, type IssueSlashSkillContext } from "./use-quick-action-menu";

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

function skill(id: string, overrides: Partial<AgentSkillSummary> = {}): AgentSkillSummary {
  return { id, name: id, description: `${id} description`, ...overrides };
}

function agent(
  id: string,
  skills: AgentSkillSummary[],
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id,
    skills,
    archived_at: null,
    owner_id: null,
    permission_mode: "public_to",
    invocation_targets: [{ target_type: "workspace", target_id: null }],
    ...overrides,
  } as Agent;
}

function squad(id: string, leaderId: string, archivedAt: string | null = null): Squad {
  return { id, leader_id: leaderId, archived_at: archivedAt } as Squad;
}

function context(overrides: Partial<IssueSlashSkillContext> = {}): IssueSlashSkillContext {
  return {
    agents: [],
    squads: [],
    members: [{ user_id: "user-1", role: "member" } as MemberWithUser],
    userId: "user-1",
    ...overrides,
  };
}

function makeEditor(): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({}) });
  editors.push(editor);
  return editor;
}

interface TestMentionContent {
  type: "mention";
  attrs: { type: string; id: string; label: string; mentionSuggestionChar: string };
}

function mention(type: string, id: string): TestMentionContent {
  return {
    type: "mention",
    attrs: { type, id, label: id, mentionSuggestionChar: "@" },
  };
}

function docWithMentions(...mentions: TestMentionContent[]): Node {
  const editor = makeEditor();
  if (mentions.length) editor.commands.insertContent(mentions);
  return editor.state.doc;
}

describe("resolveIssueSlashSkills", () => {
  it("reads a newly inserted explicit agent synchronously and locks out the assignee", () => {
    const editor = makeEditor();
    const target = agent("explicit", [skill("explicit-skill")]);
    const assignee = agent("assignee", [skill("assignee-skill")]);
    const data = context({
      issue: { assignee_type: "agent", assignee_id: assignee.id },
      agents: [target, assignee],
    });

    expect(resolveIssueSlashSkills(editor.state.doc, data).map((item) => item.id))
      .toEqual(["assignee-skill"]);

    editor.commands.insertContent([
      mention("agent", target.id),
      { type: "text", text: " " },
    ]);

    expect(resolveIssueSlashSkills(editor.state.doc, data).map((item) => item.id))
      .toEqual(["explicit-skill"]);
  });

  it("maps an explicit squad to its leader ahead of the Issue assignee", () => {
    const leader = agent("leader", [skill("leader-skill")]);
    const assignee = agent("assignee", [skill("assignee-skill")]);
    const doc = docWithMentions(mention("squad", "squad-1"));

    expect(resolveIssueSlashSkills(doc, context({
      issue: { assignee_type: "agent", assignee_id: assignee.id },
      agents: [leader, assignee],
      squads: [squad("squad-1", leader.id)],
    })).map((item) => item.id)).toEqual(["leader-skill"]);
  });

  it("unions multiple targets in document order and deduplicates agents and skills", () => {
    const first = agent("first", [skill("one"), skill("two")]);
    const second = agent("second", [skill("two"), skill("three")]);
    const leader = agent("leader", [skill("four"), skill("one")]);
    const doc = docWithMentions(
      mention("agent", first.id),
      mention("agent", second.id),
      mention("squad", "squad-1"),
      mention("agent", first.id),
    );

    expect(resolveIssueSlashSkills(doc, context({
      agents: [first, second, leader],
      squads: [squad("squad-1", leader.id)],
    })).map((item) => item.id)).toEqual(["one", "two", "three", "four"]);
  });

  it("filters archived and unauthorized targets and disabled skills without falling back", () => {
    const archived = agent("archived", [skill("archived-skill")], { archived_at: "2026-01-01" });
    const privateAgent = agent("private", [skill("private-skill")], {
      owner_id: "other-user",
      permission_mode: "private",
      invocation_targets: [],
    });
    const allowed = agent("allowed", [
      skill("enabled"),
      skill("disabled", { enabled: false }),
    ]);
    const archivedSquadLeader = agent("squad-leader", [skill("archived-squad-skill")]);
    const assignee = agent("assignee", [skill("assignee-skill")]);
    const doc = docWithMentions(
      mention("agent", archived.id),
      mention("agent", privateAgent.id),
      mention("squad", "archived-squad"),
      mention("agent", allowed.id),
    );

    expect(resolveIssueSlashSkills(doc, context({
      issue: { assignee_type: "agent", assignee_id: assignee.id },
      agents: [archived, privateAgent, allowed, archivedSquadLeader, assignee],
      squads: [squad("archived-squad", archivedSquadLeader.id, "2026-01-01")],
    })).map((item) => item.id)).toEqual(["enabled"]);
  });

  it.each([
    { assigneeType: "agent" as const, squadId: undefined },
    { assigneeType: "squad" as const, squadId: "squad-1" },
  ])("falls back to an Issue $assigneeType assignee", ({ assigneeType, squadId }) => {
    const assignee = agent("assignee", [skill("assignee-skill")]);
    const assigneeId = assigneeType === "squad" ? squadId! : assignee.id;

    expect(resolveIssueSlashSkills(docWithMentions(), context({
      issue: { assignee_type: assigneeType, assignee_id: assigneeId },
      agents: [assignee],
      squads: squadId ? [squad(squadId, assignee.id)] : [],
    })).map((item) => item.id)).toEqual(["assignee-skill"]);
  });

  it.each([null, "member" as const])(
    "returns no skills for an Issue assigned to %s without explicit targets",
    (assigneeType) => {
      const available = agent("available", [skill("unrelated-skill")]);
      expect(resolveIssueSlashSkills(docWithMentions(), context({
        issue: { assignee_type: assigneeType, assignee_id: assigneeType ? "user-2" : null },
        agents: [available],
      }))).toEqual([]);
    },
  );

  it("does not let member, issue, or project mentions suppress the assignee fallback", () => {
    const assignee = agent("assignee", [skill("assignee-skill")]);
    const doc = docWithMentions(
      mention("member", "user-2"),
      mention("issue", "issue-2"),
      mention("project", "project-2"),
    );

    expect(resolveIssueSlashSkills(doc, context({
      issue: { assignee_type: "agent", assignee_id: assignee.id },
      agents: [assignee],
    })).map((item) => item.id)).toEqual(["assignee-skill"]);
  });
});
