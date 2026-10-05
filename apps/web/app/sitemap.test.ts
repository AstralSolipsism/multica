// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_URL } from "@multica/core/deployment";
import sitemap from "./sitemap";

describe("fork sitemap", () => {
  it("retains the instance and legal pages while filtering upstream marketing entries", () => {
    expect(sitemap().map((page) => page.url)).toEqual([
      DEPLOYMENT_URL, `${DEPLOYMENT_URL}/licensing`, `${DEPLOYMENT_URL}/privacy`,
    ]);
  });
});
