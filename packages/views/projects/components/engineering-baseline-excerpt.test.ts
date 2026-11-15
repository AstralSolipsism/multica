import { describe, expect, it } from "vitest";
import { plainWikiExcerpt, wikiLinkLabel } from "./engineering-baseline-excerpt";

describe("plainWikiExcerpt", () => {
  it("strips mention protocol source to readable labels", () => {
    expect(plainWikiExcerpt("请 [@张三](mention://agent/abc-1) 看看")).toBe("请 @张三 看看");
    expect(plainWikiExcerpt("[OL-12](mention://issue/11111111-1111-4111-8111-111111111111) 关闭")).toBe("OL-12 关闭");
  });

  it("turns [[wiki links]] into the label the chip shows", () => {
    expect(plainWikiExcerpt("见 [[架构]] 章节")).toBe("见 架构 章节");
    expect(plainWikiExcerpt("见 [[architecture#部署|部署说明]] 章节")).toBe("见 部署说明 章节");
    expect(plainWikiExcerpt("见 [[architecture#部署]] 章节")).toBe("见 architecture › 部署 章节");
  });

  it("scrubs markdown control characters and collapses whitespace", () => {
    expect(plainWikiExcerpt("## 标题\n\n- **加粗** 与 `code` 和 ~~删除~~ 与 ==高亮==\n- 第二条"))
      .toBe("标题 加粗 与 code 和 删除 与 高亮 第二条");
    expect(plainWikiExcerpt("| 列一 | 列二 |\n| --- | --- |\n| a | b |")).toBe("列一 列二 a b");
    expect(plainWikiExcerpt("看 [文档](https://example.com) 和 ![图](x.png)")).toBe("看 文档 和 图");
  });

  it("keeps snake_case intact (no underscore-italic guessing)", () => {
    expect(plainWikiExcerpt("字段 some_field_name 保留")).toBe("字段 some_field_name 保留");
  });

  it("truncates by code points with an ellipsis", () => {
    expect(plainWikiExcerpt("一二三四五", 3)).toBe("一二三…");
    expect(plainWikiExcerpt("😀😀😀😀", 2)).toBe("😀😀…");
    expect(plainWikiExcerpt("短", 3)).toBe("短");
  });
});

describe("wikiLinkLabel", () => {
  it("prefers the display name, falls back to target › section", () => {
    expect(wikiLinkLabel("架构")).toBe("架构");
    expect(wikiLinkLabel("architecture|架构")).toBe("架构");
    expect(wikiLinkLabel("architecture#deploy")).toBe("architecture › deploy");
    expect(wikiLinkLabel("architecture#deploy|部署")).toBe("部署");
  });
});
