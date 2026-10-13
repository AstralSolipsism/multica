// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRestoredScrollOffset, useScrollRestorationAdapter } from "@multica/views/platform";
import { WebScrollRestorationProvider } from "./scroll-restoration";

// The provider keys memento entries by React's pathname. Tests drive it
// through this mock; `window.location` is manipulated separately to simulate
// Next committing the URL a frame AFTER the new route renders.
const nav = vi.hoisted(() => ({ pathname: "/acme/issues" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}));

function ScrollProbe({ containerKey }: { containerKey: string }) {
  const restored = useRestoredScrollOffset(containerKey);
  return <output data-testid="restored">{restored ?? "none"}</output>;
}

/** Dispatch a real scroll event from a marked container element. */
function scrollContainer(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollTop", { configurable: true, value: top });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: 2000,
  });
  el.dispatchEvent(new Event("scroll", { bubbles: false }));
}

describe("WebScrollRestorationProvider", () => {
  it("serves a captured container offset back for the same pathname", () => {
    const view = render(
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="main" data-testid="container" />
        <ScrollProbe containerKey="main" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("container"), 480);

    // Remount — the same pull the view performs after navigating back.
    view.rerender(
      <WebScrollRestorationProvider>
        <ScrollProbe containerKey="main" />
      </WebScrollRestorationProvider>,
    );
    expect(screen.getByTestId("restored").textContent).toBe("480");
  });

  it("clears the saved offset when the container scrolls back to the top", () => {
    const view = render(
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="cleared" data-testid="container" />
        <ScrollProbe containerKey="cleared" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("container"), 480);
    scrollContainer(screen.getByTestId("container"), 0);

    view.rerender(
      <WebScrollRestorationProvider>
        <ScrollProbe containerKey="cleared" />
      </WebScrollRestorationProvider>,
    );
    expect(screen.getByTestId("restored").textContent).toBe("none");
  });

  it("shields a just-served memento from the clamped scroll events a restore produces", () => {
    const view = render(
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="shielded" data-testid="container" />
        <ScrollProbe containerKey="shielded" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("container"), 480);

    // Remount serves 480 (and arms the write shield) …
    view.rerender(
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="shielded" data-testid="container" />
        <ScrollProbe containerKey="shielded" />
      </WebScrollRestorationProvider>,
    );
    expect(screen.getByTestId("restored").textContent).toBe("480");

    // … so the browser clamping the restore assignment (content not yet at
    // full height → scrollTop lands at 100) must not overwrite the memento.
    scrollContainer(screen.getByTestId("container"), 100);
    view.rerender(
      <WebScrollRestorationProvider>
        <ScrollProbe containerKey="shielded" />
      </WebScrollRestorationProvider>,
    );
    expect(screen.getByTestId("restored").textContent).toBe("480");
  });

  it("ignores scrolls from unmarked elements", () => {
    render(
      <WebScrollRestorationProvider>
        <div data-testid="plain" />
        <ScrollProbe containerKey="plain" />
      </WebScrollRestorationProvider>,
    );

    scrollContainer(screen.getByTestId("plain"), 480);
    expect(screen.getByTestId("restored").textContent).toBe("none");
  });

  // OL-270: the canonical UUID→identifier rewrite remounts the issue detail
  // while window.location still shows the UUID spelling (Next commits the URL
  // a frame later). Entries must key by the route React renders, or the
  // remounted view inherits whatever the previous route stored.
  it("keys view-state entries by the route React renders, not the uncommitted address bar", () => {
    let adapter: ReturnType<typeof useScrollRestorationAdapter> = null;
    function Probe() {
      adapter = useScrollRestorationAdapter();
      return null;
    }

    // A visit on the UUID spelling stores its record under the UUID route.
    window.history.replaceState({}, "", "/acme/issues/cb240efb-154c-42a8-ae92-42b02676feca");
    nav.pathname = "/acme/issues/cb240efb-154c-42a8-ae92-42b02676feca";
    const first = render(
      <WebScrollRestorationProvider>
        <Probe />
      </WebScrollRestorationProvider>,
    );
    adapter!.setViewState!("highlight:i1", "c1");

    // The rewrite's remounted instance renders the IDENTIFIER route while the
    // address bar still shows the UUID spelling: reading the record in that
    // window must NOT find the UUID route's entry (S1).
    nav.pathname = "/acme/issues/OL-1";
    first.rerender(
      <WebScrollRestorationProvider>
        <Probe />
      </WebScrollRestorationProvider>,
    );
    expect(adapter!.getViewState!("highlight:i1")).toBeUndefined();

    // Writes land under the rendered route too, and survive the commit.
    adapter!.setViewState!("highlight:i2", "c2");
    window.history.replaceState({}, "", "/acme/issues/OL-1");
    first.rerender(
      <WebScrollRestorationProvider>
        <Probe />
      </WebScrollRestorationProvider>,
    );
    expect(adapter!.getViewState!("highlight:i2")).toBe("c2");
  });

  // OL-270 round 3 (S3): the scroll capture listener keys by the last
  // COMMITTED pathname (a layout-effect-updated ref). A scroll that lands
  // while React is mid-navigation must go to the outgoing route, never the
  // incoming one — otherwise the first navigation silently breaks scroll
  // restore for every route by filing all offsets under the initial one.
  it("records scroll offsets under the committed route, not the one mid-navigation", () => {
    let adapter: ReturnType<typeof useScrollRestorationAdapter> = null;
    function Probe() {
      adapter = useScrollRestorationAdapter();
      return null;
    }
    const tree = () => (
      <WebScrollRestorationProvider>
        <div data-tab-scroll-root="main" data-testid="container" />
        <Probe />
      </WebScrollRestorationProvider>
    );

    nav.pathname = "/acme/issues/A";
    const view = render(tree());
    scrollContainer(screen.getByTestId("container"), 400);

    // Navigation to B starts: React hasn't committed it yet, so a scroll from
    // the still-visible page A must file under A.
    nav.pathname = "/acme/issues/B";
    scrollContainer(screen.getByTestId("container"), 500);
    // B commits; only scrolls after this point belong to B. (A fresh element
    // per rerender — React bails out of an identical element object.)
    view.rerender(tree());
    scrollContainer(screen.getByTestId("container"), 900);

    // Read each route's offset back by rendering the probe under it.
    nav.pathname = "/acme/issues/A";
    view.rerender(tree());
    expect(adapter!.get("main")?.top).toBe(500);
    nav.pathname = "/acme/issues/B";
    view.rerender(tree());
    expect(adapter!.get("main")?.top).toBe(900);
  });
});
