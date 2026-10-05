// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createI18n } from "@multica/core/i18n/react";
import { SUPPORTED_LOCALES } from "@multica/core/i18n";
import { BRAND_OVERRIDES, applyBrandOverrides } from "./brand-overrides";
import { RESOURCES, UPSTREAM_RESOURCES } from "./index";

function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, path ? `${path}.${key}` : key),
  );
}

function violations(value: unknown): string[] {
  return strings(value)
    .filter(([, text]) => /\b(?:Multica|Mika)\b/.test(text))
    .map(([path, text]) => `${path}: ${text}`);
}

const placeholders = (text: string) => [...text.matchAll(/{{\s*([^}]+)\s*}}/g)]
  .map((match) => match[1]?.trim()).sort();

describe("effective product branding", () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale}: i18next receives only fork branding in every namespace`, () => {
      const instance = createI18n(locale, RESOURCES);
      for (const ns of Object.keys(RESOURCES[locale])) {
        expect(violations(instance.getResourceBundle(locale, ns))).toEqual([]);
      }
      expect(instance.getResource(locale, "onboarding", "step_nav.wordmark")).toBe("Labrastro");
      expect(instance.getResource(locale, "onboarding", "mika_intro.name")).toBe("Mizuki");
      for (const key of ["title", "description", "action", "failed", "dialog_title"]) {
        expect(instance.getResource(locale, "runtimes", `mika_setup.${key}`)).toContain("Mizuki");
      }
      expect(instance.getResource(locale, "runtimes", "mika_setup.dialog_description")).toBeUndefined();
    });

    it(`${locale}: overrides refer to live upstream keys and retain interpolation parameters`, () => {
      const original = new Map(strings(UPSTREAM_RESOURCES[locale]));
      for (const [key, text] of strings(BRAND_OVERRIDES[locale])) {
        const upstream = original.get(key);
        expect(upstream, `stale override: ${locale}.${key}`).toBeTypeOf("string");
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(upstream!));
        // Fail if upstream changes the meaning of an overridden sentence, too;
        // an old overlay must not silently conceal new prerequisites or advice.
        expect(text, `review upstream copy change: ${locale}.${key}`).toBe(
          upstream!.replace(/\bMultica\b/g, "Labrastro").replace(/\bMika\b/g, "Mizuki"),
        );
      }
    });
  }

  it("does not mutate upstream bundles, including when reapplied for resource reloads", () => {
    const before = structuredClone(UPSTREAM_RESOURCES);
    const branded = applyBrandOverrides(UPSTREAM_RESOURCES);
    expect(UPSTREAM_RESOURCES).toEqual(before);
    expect(applyBrandOverrides(branded)).toEqual(branded);
    expect(UPSTREAM_RESOURCES.en.onboarding).toHaveProperty("step_nav.wordmark", "Multica");
  });

  it("rejects a new upstream key containing Start with Mika instead of silently rewriting it", () => {
    const resources = structuredClone(UPSTREAM_RESOURCES);
    resources.en.onboarding!.new_upstream_card = "Start with Mika";
    expect(violations(applyBrandOverrides(resources))).toContain(
      "en.onboarding.new_upstream_card: Start with Mika",
    );
  });

  it("rejects a regression in an existing effective override", () => {
    const resources = structuredClone(RESOURCES);
    const setup = resources.en.runtimes!.mika_setup as Record<string, string>;
    setup.action = "Start with Mika";
    expect(violations(resources)).toEqual(["en.runtimes.mika_setup.action: Start with Mika"]);
  });
});
