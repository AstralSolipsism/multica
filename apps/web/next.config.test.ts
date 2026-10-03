// @vitest-environment node
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
  // preview/apply/rescan up to 180s (fork constant in
  // server/internal/handler/labrastro_skill_packages.go; single-skill
  // import/refresh keep the upstream 45s importFetchTimeout). A ~35s apply
  // was cut at ~30s and its per-item report never reached the browser
  // (OL-106 integration finding). The configured timeout must outlast the
  // 180s package deadline — with margin for the server's own failure report
  // — so the server response is what the UI renders.
  it("sets experimental.proxyTimeout to 240s, above the 180s package deadline", async () => {
    const config = await loadConfig();
    const proxyTimeout = config.experimental?.proxyTimeout;
    expect(proxyTimeout).toBe(240_000);
    expect(proxyTimeout).toBeGreaterThan(180_000);
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
