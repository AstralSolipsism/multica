// @vitest-environment node
import { expect, it } from "vitest";
import { ApiError } from "../api";
import { larkTargetChatsInfiniteOptions, larkMessageAnchorsInfiniteOptions } from "./queries";

it("preserves bounded discovery read retries after parse errors gain codes", () => {
  for (const options of [
    larkTargetChatsInfiniteOptions("ws", "inst", "", 0),
    larkMessageAnchorsInfiniteOptions("ws", "inst", "chat", 0),
  ]) {
    const retry = options.retry;
    if (typeof retry !== "function") throw new Error("Expected a retry policy");
    const unreadable = new ApiError("diagnostic", 0, "", { code: "response_unreadable" });
    expect(retry(0, unreadable)).toBe(true);
    expect(retry(2, unreadable)).toBe(false);
    expect(retry(0, new ApiError("forbidden", 403, ""))).toBe(false);
  }
});
