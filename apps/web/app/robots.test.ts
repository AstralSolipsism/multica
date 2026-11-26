// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_URL } from "@multica/core/deployment";
import robots from "./robots";

describe("robots.txt", () => {
  const { rules, sitemap: sitemaps } = robots();
  const groups = Array.isArray(rules) ? rules : [rules];

  it("welcomes AI search and assistant crawlers to the internal site and docs", () => {
    const ai = groups.find((group) => Array.isArray(group.userAgent) && group.userAgent.includes("ClaudeBot"));
    expect(ai?.userAgent).toEqual(
      expect.arrayContaining(["ClaudeBot", "Claude-User", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Google-Extended"]),
    );
    expect(ai?.allow).toEqual(expect.arrayContaining(["/", "/docs/"]));
    expect(ai?.allow).not.toContain("/llms.txt");
  });

  it("keeps private app routes closed to every crawler", () => {
    for (const group of groups) {
      expect(group.disallow).toEqual(expect.arrayContaining(["/api/", "/auth/", "/issues", "/settings"]));
    }
    expect(sitemaps).toEqual([`${DEPLOYMENT_URL}/sitemap.xml`, `${DEPLOYMENT_URL}/docs/sitemap.xml`]);
  });
});
