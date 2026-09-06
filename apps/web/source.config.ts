import { defineConfig } from "fumadocs-mdx/config";

// The use-cases MDX collection (and its custom frontmatter schema) was
// removed with the marketing surface. This config stays because the
// fumadocs-mdx build step expects a source.config.ts at the workspace root.
export default defineConfig({
  mdxOptions: {},
});
