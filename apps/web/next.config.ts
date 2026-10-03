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

// Skill package preview/apply/rescan allow up to 180s server-side (fork
// constant in server/internal/handler/labrastro_skill_packages.go). The
// rewrite proxy must outlast that deadline so the server's answer — a full
// per-item report or its own deadline failure — reaches the browser: Next's
// 30s default (next/dist/server/lib/router-utils/proxy-request.js) used to
// cut a ~35s apply and lose the report (OL-106 finding). 240s leaves a 60s
// margin, matches the CLI client floor, and stays under common browser wait
// limits (~300s). Single-skill import/refresh keep their own 45s deadline.
const SKILL_PACKAGE_PROXY_TIMEOUT_MS = 240_000;

const nextConfig: NextConfig = {
  ...(process.env.STANDALONE === "true" ? { output: "standalone" as const } : {}),
  experimental: {
    proxyTimeout: SKILL_PACKAGE_PROXY_TIMEOUT_MS,
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
