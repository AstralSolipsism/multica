import nextConfig from "@multica/eslint-config/next";

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
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
    rules: {
      "react/display-name": "off",
    },
  },
];
