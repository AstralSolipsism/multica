import type { NextConfig } from "next";
import { config } from "dotenv";
import { resolve } from "path";
import {
  resolveDevDocsUrl,
  resolveDevRemoteApiUrl,
  resolveDocsUrl,
  resolveRemoteApiUrl,
} from "./config/runtime-urls";
import { createMDX } from "fumadocs-mdx/next";

// Load root .env so local next.config.ts rewrites see REMOTE_API_URL / DOCS_URL.
// Production requests use proxy.ts runtime rewrites, which read process.env
// when the Next.js server runs instead of baking these URLs at build time.
config({ path: resolve(__dirname, "../../.env") });

// `next dev` falls back to the conventional localhost upstreams; builds use
// the strict resolvers so prebuilt images keep unset upstreams unproxied.
const isDev = process.env.NODE_ENV === "development";
const remoteApiUrl = isDev
  ? resolveDevRemoteApiUrl(process.env)
  : resolveRemoteApiUrl(process.env);
const docsUrl = isDev
  ? resolveDevDocsUrl(process.env)
  : resolveDocsUrl(process.env);

// Parse hostnames from CORS_ALLOWED_ORIGINS so that Next.js dev server
// allows cross-origin HMR / webpack requests (e.g. from Tailscale IPs).
const allowedDevOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => {
        try {
          return new URL(origin.trim()).host;
        } catch {
          return origin.trim();
        }
      })
      .filter(Boolean)
  : undefined;

const nextConfig: NextConfig = {
  ...(process.env.STANDALONE === "true" ? { output: "standalone" as const } : {}),
  experimental: {
    // The rewrite proxy times out upstream responses after 30s by default
    // (next/dist/server/lib/router-utils/proxy-request.js), which is shorter
    // than the backend's 45s deadline for skill package preview/apply
    // (server/internal/handler/skill.go importFetchTimeout). A slow apply
    // through the proxy would be cut at 30s and its per-item report lost.
    // 60s matches the CLI client timeout and stays above the server deadline.
    proxyTimeout: 60_000,
    // proxy.ts matches /api/**, so Next buffers every proxied request body and
    // silently truncates it past this size (10 MB by default). Uploads above
    // that reached the backend as a cut multipart body and the browser only
    // saw "Failed to fetch". Cover the 100 MB upload cap
    // (packages/core/constants/upload.ts, server/internal/handler/file.go)
    // plus multipart framing so the backend stays the one enforcing it.
    proxyClientMaxBodySize: 101 * 1024 * 1024,
  },
  transpilePackages: ["@multica/core", "@multica/ui", "@multica/views"],
  ...(allowedDevOrigins && allowedDevOrigins.length > 0
    ? { allowedDevOrigins }
    : {}),
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [75, 80, 85],
  },
  async rewrites() {
    return {
      // Run before file-system routes so /docs isn't shadowed by the
      // [workspaceSlug] dynamic segment.
      beforeFiles: docsUrl
        ? [
            {
              source: "/docs",
              destination: `${docsUrl}/docs`,
            },
            {
              source: "/docs/:path*",
              destination: `${docsUrl}/docs/:path*`,
            },
          ]
        : [],
      afterFiles: remoteApiUrl
        ? [
            {
              source: "/v1/:path*",
              destination: `${remoteApiUrl}/v1/:path*`,
            },
            {
              source: "/api/:path*",
              destination: `${remoteApiUrl}/api/:path*`,
            },
            {
              source: "/ws",
              destination: `${remoteApiUrl}/ws`,
            },
            {
              source: "/health",
              destination: `${remoteApiUrl}/health`,
            },
            {
              source: "/auth/:path*",
              destination: `${remoteApiUrl}/auth/:path*`,
            },
            {
              source: "/uploads/:path*",
              destination: `${remoteApiUrl}/uploads/:path*`,
            },
          ]
        : [],
      fallback: [],
    };
  },
};

// fumadocs-mdx@12 is incompatible with Next 16's Turbopack: its loader fails to
// dynamic-import `.source/source.config.mjs` under the Turbopack Node evaluator
// (see fumadocs#2658). `dev`/`build` scripts pass `--webpack` to opt out.
// Drop the flag once fumadocs-mdx ships a Turbopack-compatible loader.
const withMDX = createMDX() as (config: NextConfig) => NextConfig;

export default withMDX(nextConfig);
