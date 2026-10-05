// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError } from "./client";
import { installLabrastroApiMethods, parseConfirmedWrite, parseRequiredResponse } from "./labrastro-api-helpers";
import { installLabrastroSkillApi } from "./labrastro-skill-api";

describe("fork API installation", () => {
  it("keeps class method descriptors and the calling instance", () => {
    class Client { value = "instance"; }
    const method = function (this: Client) { return this.value; };
    installLabrastroApiMethods(Client, { method });
    expect(Object.getOwnPropertyDescriptor(Client.prototype, "method")).toEqual({
      value: method, writable: true, configurable: true, enumerable: false,
    });
    expect(Reflect.get(new Client(), "method").call(new Client())).toBe("instance");
  });

  it.each([false, true])("rejects own/inherited collisions before any installation (inherited=%s)", (inherited) => {
    const original = () => "upstream";
    const existing = { collision: original };
    const target = { prototype: inherited ? Object.create(existing) : existing };
    expect(() => installLabrastroApiMethods(target, {
      first: () => "fork", collision: () => "fork",
    })).toThrow("collision");
    expect(target.prototype.collision).toBe(original);
    expect(target.prototype).not.toHaveProperty("first");
  });

  it("guards the existing skill installer and rejects repeat installation", () => {
    // A structural stand-in avoids mutating the real, already-mounted client.
    const target = { prototype: {} } as Parameters<typeof installLabrastroSkillApi>[0];
    installLabrastroSkillApi(target);
    const original = target.prototype.importSkillParsed;
    expect(() => installLabrastroSkillApi(target)).toThrow("importSkillParsed");
    expect(target.prototype.importSkillParsed).toBe(original);
  });

  it.each(["skill", "message-delivery", "dependency", "lark", "quota"])("loads the %s module before the client without an initialization cycle", async (name) => {
    vi.resetModules();
    await import(`./labrastro-${name}-api.ts`);
    const { ApiClient } = await import("./client");
    expect(typeof new ApiClient("https://example.test").importSkillParsed).toBe("function");
    expect(typeof ApiClient.prototype.getIssueGraph).toBe("function");
    expect(typeof ApiClient.prototype.getGlmQuota).toBe("function");
    expect(typeof ApiClient.prototype.setLarkConversation).toBe("function");
    expect(typeof ApiClient.prototype.createMessageRoute).toBe("function");
  });
});

describe("response policies", () => {
  const schema = z.object({ id: z.string(), confirmed: z.boolean().default(false) });
  const endpoint = "POST /api/example";

  it("preserves parsed defaults without confusing valid reads with confirmed writes", () => {
    expect(parseRequiredResponse({ id: "saved" }, schema, endpoint)).toEqual({ id: "saved", confirmed: false });
    expect(parseConfirmedWrite({ id: "saved", confirmed: true }, schema, endpoint, (v) => v.confirmed)).toEqual({
      id: "saved", confirmed: true,
    });
  });

  it.each([null, undefined, {}, { id: 42 }])("rejects unreadable reads with a stable code: %j", (raw) => {
    expect(() => parseRequiredResponse(raw, schema, endpoint)).toThrow(expect.objectContaining({
      name: "ApiError", status: 0, body: { code: "response_unreadable" },
    }));
  });

  it.each([null, {}, { id: "saved" }, { id: "saved", confirmed: false }])("never confirms a malformed or unproven write: %j", (raw) => {
    expect(() => parseConfirmedWrite(raw, schema, endpoint, (v) => v.confirmed)).toThrow(ApiError);
    expect(() => parseConfirmedWrite(raw, schema, endpoint, (v) => v.confirmed)).toThrow(expect.objectContaining({
      body: { code: "response_unconfirmed" },
    }));
  });
});
