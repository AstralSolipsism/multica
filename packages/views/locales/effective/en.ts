import {
  mergeResources,
  type LocaleResources,
} from "@multica/core/i18n";
import resources from "../en";
import brandOverrides from "../brand/en.json";

// The effective en bundle — raw namespaces under the Labrastro brand
// overlay — as a single shared module so the aggregate index and the web's
// per-locale chunks hand consumers the identical object.

const effective: LocaleResources = mergeResources(resources, brandOverrides);

export default effective;
