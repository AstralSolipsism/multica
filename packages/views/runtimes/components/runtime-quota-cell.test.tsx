// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MiniMeterBar, TONE_BAR_CLASS } from "./runtime-quota-cell";

describe("MiniMeterBar", () => {
  it("fills with the tone's color by default", () => {
    const { container } = render(
      <MiniMeterBar percent={50} tone="destructive" ariaLabel="q" />,
    );
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator?.className).toContain(TONE_BAR_CLASS.destructive);
  });

  it("lets the caller override the fill for non-health states", () => {
    // A stale host-metrics sample passes a neutral gray: it is not a health
    // judgment, so it must not inherit the (green) "ok" tone.
    const { container } = render(
      <MiniMeterBar
        percent={95}
        tone="ok"
        barClassName="bg-muted-foreground/50"
        ariaLabel="cpu"
      />,
    );
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator?.className).toContain("bg-muted-foreground/50");
    expect(indicator?.className).not.toContain(TONE_BAR_CLASS.ok);
  });
});
