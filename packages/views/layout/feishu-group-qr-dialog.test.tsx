import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation";
import type { NavigationAdapter } from "../navigation/types";
import enLayout from "../locales/en/layout.json";
import { FeishuQrDialog } from "./feishu-group-qr-dialog";

// Regression test for the OL-14 review finding: the desktop renderer runs
// on a `file://` origin, so the QR image URL must come from the navigation
// adapter's `getShareableUrl` (the platform-owned web URL of the connected
// environment) — never a site-relative path, which only a web document can
// resolve. Cases 1–3 are the review repro, adapted to the adapter-driven
// implementation: the URL follows the adapter, with and without config
// state, and tracks an adapter change on re-render.
vi.mock("../i18n", () => ({
  useT: () => ({
    t: (selector: (r: typeof enLayout) => string) => selector(enLayout),
  }),
}));

const appUrl = "https://multica.outlune.com";

function adapterFor(origin: string): NavigationAdapter {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/acme/issues",
    searchParams: new URLSearchParams(),
    hash: "",
    getShareableUrl: (path) => `${origin}${path}`,
  };
}

describe("FeishuQrDialog image URL", () => {
  it("resolves the QR through the adapter's shareable URL (desktop review case)", () => {
    render(
      <NavigationProvider value={adapterFor(appUrl)}>
        <FeishuQrDialog open onOpenChange={vi.fn()} />
      </NavigationProvider>,
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      `${appUrl}/feishu-group-qr.png`,
    );
  });

  it("falls back to the site-relative path outside a provider (web-only mount)", () => {
    // The fallback is only reachable where a web document serves /public —
    // the desktop shell always mounts the navigation provider before the
    // sidebar that hosts this dialog.
    render(<FeishuQrDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "/feishu-group-qr.png",
    );
  });

  it("follows the adapter when it changes while mounted", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <NavigationProvider value={adapterFor("https://old.example.com")}>
        <FeishuQrDialog open onOpenChange={onOpenChange} />
      </NavigationProvider>,
    );

    rerender(
      <NavigationProvider value={adapterFor(appUrl)}>
        <FeishuQrDialog open onOpenChange={onOpenChange} />
      </NavigationProvider>,
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      `${appUrl}/feishu-group-qr.png`,
    );
  });
});
