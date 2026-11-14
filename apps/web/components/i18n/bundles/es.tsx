"use client";

import localeResources from "@multica/views/locales/effective/es";
import type { LocaleBundleProps } from "../locale-bundle";

const resources = { "es": localeResources };

export default function Bundle({ children }: LocaleBundleProps) {
  return <>{children(resources)}</>;
}
