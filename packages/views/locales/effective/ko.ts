import {
  mergeResources,
  type LocaleResources,
} from "@multica/core/i18n";
import resources from "../ko";
import brandOverrides from "../brand/ko.json";

// The effective ko bundle — raw namespaces under the Labrastro brand
// overlay — as a single shared module so the aggregate index and the web's
// per-locale chunks hand consumers the identical object.

const effective: LocaleResources = mergeResources(resources, brandOverrides);

export default effective;
