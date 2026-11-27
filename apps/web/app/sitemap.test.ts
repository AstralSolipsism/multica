// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_URL } from "@multica/core/deployment";
import { isLiveRoute, siteRoutes } from "@/features/landing/site/sitemap";
import { isRetiredMarketingPath } from "@/lib/labrastro-marketing";
import sitemap from "./sitemap";

describe("fork sitemap", () => {
  const entries = sitemap();
  const urls = entries.map((entry) => entry.url);

  it("lists every live internal route and filters retired marketing entries", () => {
    const live = siteRoutes().filter(isLiveRoute).filter((route) => !isRetiredMarketingPath(route));
    expect(urls).toEqual(live.map((route) => route === "/" ? DEPLOYMENT_URL : `${DEPLOYMENT_URL}${route}`));
    expect(urls).toContain(`${DEPLOYMENT_URL}/download`);
    expect(urls).not.toContain(`${DEPLOYMENT_URL}/usecases`);
  });

  it("dates only the pages that change with each release", () => {
    const dated = entries.filter((entry) => entry.lastModified).map((entry) => entry.url);
    expect(dated).toEqual([DEPLOYMENT_URL]);
  });

  it("declares every language version without retired locale roots", () => {
    const root = entries.find((entry) => entry.url === DEPLOYMENT_URL);
    expect(root?.alternates?.languages).toEqual({
      en: `${DEPLOYMENT_URL}/`,
      "x-default": `${DEPLOYMENT_URL}/`,
    });

    const download = entries.find((entry) => entry.url.endsWith("/download"));
    expect(download?.alternates?.languages).toMatchObject({
      en: `${DEPLOYMENT_URL}/download`,
      "zh-Hans": `${DEPLOYMENT_URL}/zh/download`,
      "x-default": `${DEPLOYMENT_URL}/download`,
    });
  });
});
