// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingEngineeringDestination,
  consumeEngineeringDestinationForReauth,
  isEngineeringWikiPath,
  preserveEngineeringDestinationForReauth,
} from "./engineering-deep-links";

const pagePath = "/acme/projects/p1/engineering?page=rev-1";
const sectionPath = "/acme/projects/p1/engineering?page=rev-1&section=%E5%88%86%E5%B1%82";
const threadPath = "/acme/projects/p1/engineering?thread=thread-1";

beforeEach(() => {
  clearPendingEngineeringDestination();
});

describe("isEngineeringWikiPath", () => {
  it("matches only project engineering URLs with a wiki target", () => {
    expect(isEngineeringWikiPath(pagePath)).toBe(true);
    expect(isEngineeringWikiPath(`${pagePath}#diff`)).toBe(true);
    expect(isEngineeringWikiPath(sectionPath)).toBe(true);
    expect(isEngineeringWikiPath(threadPath)).toBe(true);
    expect(isEngineeringWikiPath("/acme/projects/p1/engineering")).toBe(false);
    expect(isEngineeringWikiPath("/acme/projects/p1/engineering?page=")).toBe(false);
    expect(isEngineeringWikiPath("/acme/projects/p1?page=rev-1")).toBe(false);
    expect(isEngineeringWikiPath("/acme/issues?page=rev-1")).toBe(false);
  });
});

describe("engineering re-auth destination", () => {
  it("restores once for the same account", () => {
    preserveEngineeringDestinationForReauth("user-1", pagePath);

    expect(consumeEngineeringDestinationForReauth("user-1")).toBe(pagePath);
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();
  });

  it("does not restore into a different account", () => {
    preserveEngineeringDestinationForReauth("user-1", pagePath);

    expect(consumeEngineeringDestinationForReauth("user-2")).toBeNull();
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();
  });

  it("clears on explicit logout and rejects non-wiki paths", () => {
    preserveEngineeringDestinationForReauth("user-1", pagePath);
    clearPendingEngineeringDestination();
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();

    preserveEngineeringDestinationForReauth("user-1", "/acme/issues");
    expect(consumeEngineeringDestinationForReauth("user-1")).toBeNull();
  });
});
