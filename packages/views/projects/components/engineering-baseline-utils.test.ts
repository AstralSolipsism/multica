// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { BaselineRevision, IssueGraphNode } from "@multica/core/api";
import { baselineModuleSlug, canEditBaselineSection, createBaselineReferenceMatcher, isBaselineModuleSlug, matchBaselineReferences, mergeBaselineSections, orderedBaselineChapters, parseBaselineChapter, scanBaselineReferences } from "./engineering-baseline-utils";
import type { EngineeringStageSummary } from "./engineering-utils";

const revision = (): BaselineRevision => ({
  id: "rev-1",
  workspaceId: "ws-1",
  projectId: "project-1",
  chapter: "domain_rules",
  revisionNumber: 2,
  status: "candidate",
  contentMarkdown: "## [Rule-1] 幂等键\n所有写接口必须携带幂等键，OL-2 在 Stage 6 实现。\n\n## 预占快照\n记录快照。",
  changeSummary: "Update rules",
  baseRevisionId: "rev-base",
  replacesRevisionId: null,
  sourceIssueId: null,
  anchorsDiff: {
    chapter: "domain_rules",
    baseRevisionNumber: 1,
    added: [{ anchor: "预占快照", title: "预占快照", before: "", after: "记录快照。", beforeChars: 0, afterChars: 5 }],
    modified: [{ anchor: "Rule-1", title: "幂等键", before: "所有写接口应该携带幂等键。", after: "所有写接口必须携带幂等键。", beforeChars: 12, afterChars: 12 }],
    removed: [{ anchor: "Rule-old", title: "旧规则", before: "删除这段。", after: "", beforeChars: 5, afterChars: 0 }],
    unchangedCount: 0,
    warnings: [],
  },
  createdByType: "agent",
  createdById: "agent-1",
  createdByTaskId: null,
  createdAt: "2026-01-01T00:00:00Z",
  decidedByType: null,
  decidedById: null,
  decidedByTaskId: null,
  decidedAt: null,
  decisionCredential: null,
});

describe("parseBaselineChapter", () => {
  it("parses natural headings, skips fences, and extracts optional rationale and examples", () => {
    const document = parseBaselineChapter("domain_rules", [
      "## [Rule-1] 幂等键",
      "所有写接口必须携带幂等键。",
      "",
      "为什么：重试不能产生重复订单。",
      "",
      "例：同一请求重发两次只创建一个订单。",
      "",
      "```markdown",
      "## 不是小节",
      "```",
      "### 订单状态",
      "已支付后进入履约。",
    ].join("\n"));
    expect(document.sections).toHaveLength(2);
    expect(document.sections[0]).toMatchObject({
      key: "domain_rules:Rule-1",
      title: "幂等键",
      body: "所有写接口必须携带幂等键。\n\n```markdown\n## 不是小节\n```",
      why: "重试不能产生重复订单。",
      example: "同一请求重发两次只创建一个订单。",
    });
    expect(document.sections[1]?.title).toBe("订单状态");
  });

  it("maps filtered body lines back to the original section source", () => {
    const document = parseBaselineChapter("domain_rules", [
      "### [Rule-1] Rules",
      "",
      "First paragraph.",
      "",
      "为什么：Keep this out of the body.",
      "",
      "",
      "Second paragraph.",
    ].join("\n"));
    const section = document.sections[0]!;
    expect(section.body).toBe("First paragraph.\n\nSecond paragraph.");
    expect(section.sourceLineMap[0]).toBe(3);
    expect(section.sourceLineMap[2]).toBe(8);
  });

  it("keeps content before the first heading instead of dropping it", () => {
    const document = parseBaselineChapter("overview", "项目的自然语言简介。");
    expect(document.sections[0]).toMatchObject({ anchor: "intro", title: "", body: "项目的自然语言简介。" });
  });

  it("keeps a section's complete Markdown subtree for local editing", () => {
    const document = parseBaselineChapter("module:billing", "## 计费规则\n定义。\n\n### 结算周期\n按月结算。\n\n## 退款\n原路退回。");
    expect(document.sections.map((section) => section.markdown)).toEqual([
      "## 计费规则\n定义。\n\n### 结算周期\n按月结算。",
      "### 结算周期\n按月结算。",
      "## 退款\n原路退回。",
    ]);
  });

  it("matches backend anchors for hierarchy, duplicates, explicit keys, and whitespace", () => {
    const document = parseBaselineChapter("module:billing", [
      "  ## 计费规则",
      "### 示例",
      "## 结算规则",
      "### 示例",
      "## 重名",
      "## 重名",
      "## [可选] 计费",
      "## C#",
      "## Foo  Bar",
      "## [Rule-1] 显式标题",
    ].join("\n"));
    expect(document.sections.map((section) => section.anchor)).toEqual([
      "计费规则",
      "计费规则 / 示例",
      "结算规则",
      "结算规则 / 示例",
      "重名",
      "重名 (2)",
      "[可选] 计费",
      "C#",
      "Foo Bar",
      "Rule-1",
    ]);
    expect(document.sections[6]?.title).toBe("[可选] 计费");
  });

  it("allows local edits only when the backend query identifies one section", () => {
    const document = parseBaselineChapter("module:billing", "## 计费规则\n### 示例\n## 结算规则\n### 示例\n## 重名\n## 重名\n## [可选] 计费");
    expect(canEditBaselineSection(document.sections[1]!, document.sections)).toBe(true);
    expect(canEditBaselineSection(document.sections[3]!, document.sections)).toBe(true);
    expect(canEditBaselineSection(document.sections[4]!, document.sections)).toBe(false);
    expect(canEditBaselineSection(document.sections[5]!, document.sections)).toBe(true);
    expect(canEditBaselineSection(document.sections[6]!, document.sections)).toBe(true);

    const collision = parseBaselineChapter("module:billing", "## 计费规则\n### 示例\n## 示例");
    expect(canEditBaselineSection(collision.sections[2]!, collision.sections)).toBe(false);
  });
});

describe("baseline references", () => {
  const sections = [
    ...parseBaselineChapter("domain_rules", "## 幂等键\n定义幂等键。").sections,
    ...parseBaselineChapter("architecture", "## 调用约束\n幂等键再次出现幂等键，OL-2 在 Stage 6。").sections,
  ];
  const nodes = [{ id: "issue-2", identifier: "OL-2", title: "Implement", stage: 6 }] as IssueGraphNode[];
  const stages = [{ stage: 6, title: "Frontend", goal: "", total: 1, closed: 0 }] as EngineeringStageSummary[];

  it("marks only the first external concept occurrence in understanding mode", () => {
    const current = sections[1]!;
    const matches = matchBaselineReferences(current.body, {
      sections,
      currentSectionKey: current.key,
      nodes,
      stages,
      conceptsOnly: true,
      seenConcepts: new Set(),
    });
    expect(matches.map((match) => match.reference.kind)).toEqual(["concept"]);
    expect(current.body.slice(matches[0]!.start, matches[0]!.end)).toBe("幂等键");
  });

  it("marks concepts, issue identifiers, and stages in management mode", () => {
    const current = sections[1]!;
    const matches = matchBaselineReferences(current.body, {
      sections,
      currentSectionKey: current.key,
      nodes,
      stages,
    });
    expect(matches.map((match) => match.reference.kind)).toEqual(["concept", "concept", "issue", "stage"]);
  });

  it("does not mark generic short Chinese or English headings in natural text", () => {
    const shortSections = [
      ...parseBaselineChapter("domain_rules", "## 权限\n定义权限。").sections,
      ...parseBaselineChapter("architecture", "## 阶段\n定义阶段。").sections,
      ...parseBaselineChapter("exclusions_and_risks", "## API\n定义接口。").sections,
      ...parseBaselineChapter("overview", "## 权限模型\n定义权限模型。").sections,
      ...parseBaselineChapter("domain_rules", "## Auth\n定义认证。").sections,
    ];
    const text = "权限、阶段、API、权限模型与 Auth";
    const matches = matchBaselineReferences(text, { sections: shortSections, conceptsOnly: true });

    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["权限模型", "Auth"]);
  });

  it("matches explicit links even for short titles and preserves their display labels", () => {
    const explicitSections = [
      ...parseBaselineChapter("domain_rules", "## [Rule-1] 权限\n定义权限。").sections,
      ...parseBaselineChapter("architecture", "## API\n定义接口。").sections,
    ];
    const text = "先见 [[权限]]，再见 [[API|接口约束]] 与 [[#Rule-1|权限规则]]。";
    const matches = matchBaselineReferences(text, {
      sections: explicitSections,
      conceptsOnly: true,
      seenConcepts: new Set(),
    });

    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["[[权限]]", "[[API|接口约束]]", "[[#Rule-1|权限规则]]"]);
    expect(matches.map((match) => match.reference.label)).toEqual(["权限", "接口约束", "权限规则"]);
    expect(matches.every((match) => match.reference.kind === "concept")).toBe(true);
  });

  it("does not duplicate a long-title natural match inside an explicit link in management mode", () => {
    const explicitSections = parseBaselineChapter("domain_rules", "## 权限模型\n定义权限模型。").sections;
    const text = "见 [[权限模型]] 与权限模型";
    const matches = matchBaselineReferences(text, { sections: explicitSections, conceptsOnly: false });

    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual(["[[权限模型]]", "权限模型"]);
    expect(matches[0]!.end).toBeLessThan(matches[1]!.start);
  });
});

describe("mergeBaselineSections", () => {
  it("embeds added, modified, and removed sections in the Wiki context", () => {
    const sections = mergeBaselineSections(
      "domain_rules",
      "## [Rule-1] 幂等键\n旧正文。\n\n## [Rule-old] 旧规则\n删除这段。",
      revision(),
      true,
    );
    expect(sections.map((section) => [section.title, section.change])).toEqual([
      ["幂等键", "modified"],
      ["旧规则", "removed"],
      ["预占快照", "added"],
    ]);
    expect(sections[0]?.beforeBody).toBe("所有写接口应该携带幂等键。");
  });

  it("uses the adopted document outside comparison mode", () => {
    const sections = mergeBaselineSections("domain_rules", "## 正本\n内容。", revision(), false);
    expect(sections).toEqual([expect.objectContaining({ title: "正本", change: "same" })]);
  });
});

describe("module chapters", () => {
  it("orders global chapters before position-sorted modules", () => {
    const state = (chapter: "module:billing" | "module:attendance", position: number) => ({ chapter, title: chapter, position, adopted: null, candidate: null });
    expect(orderedBaselineChapters([state("module:billing", 20), state("module:attendance", 10)])).toEqual([
      "overview",
      "domain_rules",
      "architecture",
      "exclusions_and_risks",
      "module:attendance",
      "module:billing",
    ]);
  });

  it("generates valid customizable slugs from Latin and Chinese module names", () => {
    expect(baselineModuleSlug("Billing & Settlement")).toBe("billing-settlement");
    expect(baselineModuleSlug("计费与结算模块")).toBe("jifeiyujiesuanmokuai");
    expect(baselineModuleSlug("東京", "ja")).toBe("");
    expect(isBaselineModuleSlug("billing-settlement")).toBe(true);
    expect(isBaselineModuleSlug("Billing/settlement")).toBe(false);
    expect(isBaselineModuleSlug("-billing")).toBe(false);
  });

  it("resolves concept references from a module to the global outline", () => {
    const global = parseBaselineChapter("domain_rules", "## 幂等键\n全局定义。").sections;
    const module = parseBaselineChapter("module:billing", "## 计费请求\n使用 [[幂等键]] 防止重复扣款。").sections;
    const references = scanBaselineReferences(module[0]!, [...global, ...module], [], []);
    expect(references).toEqual([expect.objectContaining({ kind: "concept", section: expect.objectContaining({ chapter: "domain_rules", title: "幂等键" }) })]);
  });
});

describe("createBaselineReferenceMatcher", () => {
  it("matches every text node like separate calls while sharing seen concepts", () => {
    const parsed = parseBaselineChapter("architecture", "## Billing Ledger\n\nOwns invoices.\n\n## Checkout\n\nBody.").sections;
    const options = { sections: parsed, currentSectionKey: parsed[1]!.key, conceptsOnly: true };
    const texts = ["See [[Billing Ledger]] first.", "The Billing Ledger again.", "Billing Ledger once more."];
    const separateSeen = new Set<string>();
    const separate = texts.map((text) => matchBaselineReferences(text, { ...options, seenConcepts: separateSeen }));
    const match = createBaselineReferenceMatcher(options);
    const sharedSeen = new Set<string>();

    expect(texts.map((text) => match(text, sharedSeen))).toEqual(separate);
    expect(separate.map((matches) => matches.length)).toEqual([1, 0, 0]);
  });
});
