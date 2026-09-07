// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/fake-user-data") },
}));

import {
  INTERNAL_DOWNLOAD_BASE,
  latestManifestUrl,
  releaseBaseFor,
} from "./cli-bootstrap";

// Bootstrap downloads resolve against the internal release source only. The
// constants and helpers are pinned here so a future refactor cannot quietly
// reintroduce an upstream fallback URL.
describe("cli-bootstrap internal release source", () => {
  it("points at the internal download host", () => {
    expect(INTERNAL_DOWNLOAD_BASE).toBe(
      "https://multica.outlune.com/downloads",
    );
    expect(INTERNAL_DOWNLOAD_BASE).not.toContain("github.com");
  });

  it("derives the manifest URL from the download base", () => {
    expect(latestManifestUrl(INTERNAL_DOWNLOAD_BASE)).toBe(
      "https://multica.outlune.com/downloads/latest.json",
    );
  });

  it("derives the per-release base with the tag as published", () => {
    expect(
      releaseBaseFor(INTERNAL_DOWNLOAD_BASE, "v0.4.40-labrastro.2"),
    ).toBe(
      "https://multica.outlune.com/downloads/cli/v0.4.40-labrastro.2",
    );
  });
});
