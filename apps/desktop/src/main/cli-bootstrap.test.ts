// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/fake-user-data") },
}));

import {
  INTERNAL_DOWNLOAD_BASE,
  latestManifestUrl,
  parseLatestManifestVersion,
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

// The manifest is network input and must never be trusted by shape: it is
// parsed through parseWithFallback + a strict zod schema, so any schema miss
// (mirrored, truncated, or error-page response) falls back to null and is
// rejected with the same clear manifest error instead of a TypeError from
// reading a field that isn't there.
describe("parseLatestManifestVersion", () => {
  it("returns the trimmed version from a well-formed manifest", () => {
    expect(
      parseLatestManifestVersion({ version: "  v0.4.40-labrastro.2  " }),
    ).toBe("v0.4.40-labrastro.2");
  });

  it("rejects a JSON null body", () => {
    expect(() => parseLatestManifestVersion(null)).toThrow(
      "latest.json did not contain a version string",
    );
  });

  it("rejects non-object bodies (arrays, strings, numbers)", () => {
    for (const body of [["v0.4.40-labrastro.2"], "v0.4.40-labrastro.2", 42]) {
      expect(() => parseLatestManifestVersion(body)).toThrow(
        "latest.json did not contain a version string",
      );
    }
  });

  it("rejects a manifest missing the version field", () => {
    expect(() => parseLatestManifestVersion({ channel: "internal" })).toThrow(
      "latest.json did not contain a version string",
    );
  });

  it("rejects a wrong-typed or blank version field", () => {
    for (const body of [{ version: 42 }, { version: "" }, { version: "   " }]) {
      expect(() => parseLatestManifestVersion(body)).toThrow(
        "latest.json did not contain a version string",
      );
    }
  });
});
