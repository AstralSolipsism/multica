// @vitest-environment node
import { expect, it } from "vitest";
import {
  quotaSourceKeys,
  quotaSourceListOptions,
  runtimeKeys,
  workspaceQuotaSourceListOptions,
} from "./queries";

it("keeps account management and workspace cards in their required query trees", () => {
  expect(quotaSourceKeys.all()).toEqual(["me", "quota-sources"]);
  expect(quotaSourceListOptions().queryKey).toEqual(quotaSourceKeys.all());
  expect(runtimeKeys.quotaSources("ws-1")).toEqual(["runtimes", "ws-1", "quota-sources"]);
  expect(workspaceQuotaSourceListOptions("ws-1").queryKey).toEqual(
    runtimeKeys.quotaSources("ws-1"),
  );
});
