import { describe, expect, it } from "vitest";
import { createEnDict } from "./en";
import { createJaDict } from "./ja";
import { createKoDict } from "./ko";
import { createZhDict } from "./zh";
import type { LandingDict } from "./types";

// Upstream legal/privacy notices keep their attribution (docs/engineering/
// branding.md): the operator entity (Index Labs (Hong Kong) Limited, a.k.a.
// "Multica"), the Multica License conditions and the "built on Multica"
// attribution clause are upstream legal statements, not product copy. A bulk
// brand sweep must not rewrite them, so pin the protected sections against
// fork-brand leakage and entity loss for every shipped landing dictionary.
const DICTS: [name: string, dict: () => LandingDict][] = [
  ["en", createEnDict],
  ["zh", createZhDict],
  ["ja", createJaDict],
  ["ko", createKoDict],
];

describe("landing legal attribution", () => {
  for (const [name, createDict] of DICTS) {
    const dict = createDict();

    it(`${name}: licensing keeps the upstream license terms unbranded`, () => {
      expect(JSON.stringify(dict.licensing)).not.toContain("Labrastro");
      expect(JSON.stringify(dict.licensing)).toContain(
        "https://github.com/multica-ai/multica/blob/main/LICENSE",
      );
    });

    it(`${name}: privacy names the upstream operator entity`, () => {
      expect(JSON.stringify(dict.privacy)).toContain(
        "Index Labs (Hong Kong) Limited",
      );
      expect(JSON.stringify(dict.privacy)).not.toContain("Labrastro");
    });
  }
});
