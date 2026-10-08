// @vitest-environment node
import { MAX_FILE_SIZE } from "@multica/core/constants/upload";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadConfig() {
  const mod = await import("./next.config");
  return mod.default;
}

describe("next.config rewrite proxy timeout", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Self-host default topology proxies /api/* through the Next rewrite proxy
  // (REMOTE_API_URL set, NEXT_PUBLIC_API_URL empty). Next caps an upstream
  // response at 30s by default, while the backend allows skill package
  // preview/apply up to 45s (server/internal/handler/skill.go
  // importFetchTimeout). A ~35s apply was cut at ~30s and its per-item report
  // never reached the browser (OL-106 integration finding). The configured
  // timeout must stay above the server deadline so the server response —
  // success or its own 45s failure — is what the UI renders.
  it("sets experimental.proxyTimeout above the 45s server deadline", async () => {
    const config = await loadConfig();
    const proxyTimeout = config.experimental?.proxyTimeout;
    expect(proxyTimeout).toBe(60_000);
    expect(proxyTimeout).toBeGreaterThan(45_000);
  });

  it("keeps the API rewrite proxy in place", async () => {
    vi.stubEnv("REMOTE_API_URL", "http://backend:8080");
    const config = await loadConfig();
    const rewrites = await config.rewrites?.();
    const afterFiles =
      rewrites && !Array.isArray(rewrites) ? rewrites.afterFiles : [];
    expect(
      afterFiles?.some(
        (r) => r.source === "/api/:path*" || r.source === "/v1/:path*",
      ),
    ).toBe(true);
  });
});

describe("next.config proxy request body buffer", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // proxy.ts matches /api/**, so Next buffers every proxied request body and
  // silently truncates it past proxyClientMaxBodySize (10 MB by default). An
  // 18 MB chat attachment reached /api/upload-file as a cut multipart body and
  // the browser only saw "Failed to fetch" (OL-143). The buffer must hold a
  // full upload at the client cap plus multipart framing, so the backend's own
  // 100 MB check (server/internal/handler/file.go maxUploadSize) is what
  // rejects oversized files.
  it("buffers proxied request bodies above the upload cap", async () => {
    const config = await loadConfig();
    const limit = config.experimental?.proxyClientMaxBodySize;
    expect(typeof limit).toBe("number");
    expect(limit as number).toBeGreaterThan(MAX_FILE_SIZE);
  });
});
