import nextConfig from "@multica/eslint-config/next";
import { NO_SYSTEM_ONLY_REDUCED_MOTION } from "@multica/eslint-config/reduced-motion";
import {
  NO_UNTRANSLATED_ATTRIBUTES,
  NO_UNTRANSLATED_JSX_TEXT,
  NO_UNTRANSLATED_TOAST,
} from "../../packages/views/eslint-i18n-guard.mjs";

const TESTS = ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"];

export default [
  ...nextConfig,
  { ignores: [".next/", ".source/"] },
  {
    // The root-layout provider chain must stay leaf-only: the issues
    // components barrel drags the whole issue-detail graph (editors
    // included) into every page's initial chunk — see OL-270. Platform code
    // imports deep-link helpers from the leaf `@multica/views/issues/
    // comment-deep-link` instead.
    files: [
      // (sub-array = AND: platform files that are not tests)
      ["platform/**/*.{ts,tsx}", "!**/*.test.{ts,tsx}"],
      "components/web-providers.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@multica/views/issues/components",
              message:
                "Root-layout provider chain must not pull the issues barrel (bundle regression, OL-270). Import from @multica/views/issues/comment-deep-link or another leaf module.",
            },
          ],
        },
      ],
    },
  },
  {
    // The marketing site never mounts the Appearance settings, so the system
    // setting is the only one it can follow.
    files: ["**/*.{ts,tsx}"],
    ignores: ["app/(landing)/**", "features/landing/**", ...TESTS],
    rules: {
      "no-restricted-syntax": ["error", NO_SYSTEM_ONLY_REDUCED_MOTION],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    ignores: ["app/(landing)/**", ...TESTS],
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_UNTRANSLATED_ATTRIBUTES,
        NO_UNTRANSLATED_JSX_TEXT,
        NO_UNTRANSLATED_TOAST,
        NO_SYSTEM_ONLY_REDUCED_MOTION,
      ],
    },
  },
  {
    files: TESTS,
    rules: {
      "react/display-name": "off",
    },
  },
];
