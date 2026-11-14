import {
  mergeResources,
  type LocaleResources,
} from "@multica/core/i18n";
import resources from "../ru";
import brandOverrides from "../brand/ru.json";

// The effective ru bundle — raw namespaces under the Labrastro brand
// overlay — as a single shared module so the aggregate index and the web's
// per-locale chunks hand consumers the identical object.

const effective: LocaleResources = mergeResources(resources, brandOverrides);

export default effective;
