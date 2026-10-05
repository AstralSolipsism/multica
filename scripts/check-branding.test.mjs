import assert from "node:assert/strict";
import { test } from "node:test";
import { hasRetiredBrand, sourceViolations } from "./check-branding.mjs";
import policy from "./branding-policy.json" with { type: "json" };

test("rejects old copy, including CJK suffixes and template/JSX text", () => {
  for (const text of ["Start with Mika", "Multicaへようこそ", "Mika와 시작", "登录 Multica"])
    assert.equal(hasRetiredBrand(text), true, text);
  assert.equal(sourceViolations("card.tsx", 'const card = <div>Start with Mika</div>').length, 1);
  assert.equal(sourceViolations("card.ts", 'const title = `Mika says ${name}`').length, 1);
});

test("preserves technical identities without exempting surrounding copy", () => {
  assert.equal(hasRetiredBrand("multica setup MULTICA_APP_URL @multica/core multica:// https://github.com/multica-ai/multica"), false);
  assert.equal(sourceViolations("api.ts", '// Mika\nconst MikaDefaultName = "Mizuki";').length, 0);
  assert.equal(hasRetiredBrand("X-Multica-Signature"), false);
  assert.equal(hasRetiredBrand("Use X-Multica-Signature to connect to Multica"), true);
  for (const group of Object.values(policy)) {
    for (const entry of group) assert.ok(entry.reason.trim(), JSON.stringify(entry));
  }
});
