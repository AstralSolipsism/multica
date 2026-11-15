import {
  mergeResources,
  type LocaleResources,
} from "@multica/core/i18n";
import resources from "../zh-Hant";
import brandOverrides from "../brand/zh-Hant.json";
import fallbackResources from "../zh-Hans";
import fallbackBrandOverrides from "../brand/zh-Hans.json";

// The effective zh-Hant bundle — raw namespaces under the Labrastro brand
// overlay — as a single shared module so the aggregate index and the web's
// per-locale chunks hand consumers the identical object.

// Mirrors the fork fallback: branded Simplified Chinese fills the namespaces
// Traditional Chinese does not translate yet, then zh-Hant copy wins.
const brandedFallback = mergeResources(fallbackResources, fallbackBrandOverrides);
const effective: LocaleResources = mergeResources(
  mergeResources(brandedFallback, resources),
  brandOverrides,
);

export default effective;
