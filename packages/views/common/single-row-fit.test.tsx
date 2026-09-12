/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useSingleRowFit } from "./single-row-fit";

// Measured from the OL-45 failing production view. At 734px the active
// sixth tab fits beside "more", but not beside its own promoted trigger.
const widths = [37, 80, 66, 128, 128, 160, 160];

function Bar({ available, active = 5, count = widths.length }: {
  available: number; active?: number; count?: number;
}) {
  const { containerRef, measureRef, fitCount } = useSingleRowFit({
    count, gap: 4, reserve: 36, overflowReserve: 68,
    promotedIndex: active, promotedReserve: 236,
  });
  return (
    <div ref={containerRef} data-width={available}>
      <div ref={measureRef}>
        {widths.slice(0, count).map((width, i) => <span key={i} data-width={width} />)}
      </div>
      <output data-testid="fit">{fitCount}</output>
    </div>
  );
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.width ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.width ?? 0);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("settles the edge tab after load and repeated active-view changes", () => {
  const view = render(<Bar available={734} count={0} />);
  expect(screen.getByTestId("fit")).toHaveTextContent("0");
  for (let i = 0; i < 4; i++) {
    view.rerender(<Bar available={734} active={5} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("6");
    view.rerender(<Bar available={734} active={6} />);
    expect(screen.getByTestId("fit")).toHaveTextContent("5");
  }
});

it("reserves the promoted trigger only when needed and releases space on growth", () => {
  const view = render(<Bar available={1000} />);
  for (const [available, expected] of [[1000, 7], [734, 6], [680, 4], [500, 3], [734, 6], [1000, 7]]) {
    view.rerender(<Bar available={available!} />);
    expect(screen.getByTestId("fit")).toHaveTextContent(String(expected));
  }
});
