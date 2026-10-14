// @vitest-environment node
/**
 * OL-270 round 3 — SSR smoke for the root-layout navigation provider.
 * `WebNavigationProvider` wraps the whole app; any unguarded `window` read in
 * its render body throws on the server, and every page then falls back to
 * client rendering (React #419: empty HTML until JS loads). jsdom suites
 * never catch this — there is always a `window` — so this one runs in node.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/acme/issues/OL-1",
  useSearchParams: () => new URLSearchParams(),
}));

import { WebNavigationProvider } from "./navigation";

describe("WebNavigationProvider SSR", () => {
  it("server-renders its children (no window on the server)", () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a[0]); });
    const html = renderToString(
      <WebNavigationProvider>
        <p>server-rendered child</p>
      </WebNavigationProvider>,
    );
    spy.mockRestore();
    expect(html).toContain("server-rendered child");
    // No client-rendering fallback, no swallowed render error.
    expect(errors.map(String).join(" | ")).not.toContain("Switched to client rendering");
  });
});
