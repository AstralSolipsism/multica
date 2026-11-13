// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isRetiredMarketingPath } from "./labrastro-marketing";

describe("retired marketing route trees", () => {
  it.each([
    "/about", "/homepage", "/changelog", "/contact-sales", "/usecases",
    "/blog", "/careers", "/customers", "/press", "/pricing", "/product",
    "/security", "/solutions", "/about/", "/usecases/auto-data-analysis",
    "/usecases/auto-data-analysis.en", "/ABOUT", "/%61bout",
    "/usecases%2Fauto-data-analysis", "/about/%zz", "/zh", "/ja", "/ko",
    "/zh/about", "/ja/pricing", "/ko/product/desktop",
  ])("retires %s", (path) => {
    expect(isRetiredMarketingPath(path)).toBe(true);
  });

  it.each([
    "/", "/download", "/licensing", "/privacy", "/login", "/onboarding",
    "/zh/download", "/ja/licensing", "/ko/privacy", "/zh/issues",
    "/acme/about", "/about-us", "/usecases-team/issues", "/api/contact-sales",
    "/docs/about", "/%zz",
  ])("keeps unrelated path %s", (path) => {
    expect(isRetiredMarketingPath(path)).toBe(false);
  });
});
