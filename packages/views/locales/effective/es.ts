import {
  mergeResources,
  type LocaleResources,
} from "@multica/core/i18n";
import resources from "../es";
import brandOverrides from "../brand/es.json";
import fallbackResources from "../en";
import fallbackBrandOverrides from "../brand/en.json";

// The effective es bundle — raw namespaces under the Labrastro brand
// overlay — as a single shared module so the aggregate index and the web's
// per-locale chunks hand consumers the identical object.

// Mirrors the fork fallback: branded English fills the fork namespaces the
// Spanish locale does not translate yet, then Spanish copy wins.
const brandedFallback = mergeResources(fallbackResources, fallbackBrandOverrides);
const effective: LocaleResources = mergeResources(
  mergeResources(brandedFallback, resources),
  brandOverrides,
);

export default effective;
