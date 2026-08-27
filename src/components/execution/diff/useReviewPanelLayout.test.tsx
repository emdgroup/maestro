import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  reviewPanelLayout,
  clampSidebarWidth,
  readSidebarWidth,
  readPanelOpen,
  useReviewPanelLayout,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from "./useReviewPanelLayout";
import { estimateDiffHeight } from "./estimate-diff-height";

describe("reviewPanelLayout", () => {
  it("floats the panel below 1300px and inlines it at or above", () => {
    expect(reviewPanelLayout(1299)).toBe("overlay");
    expect(reviewPanelLayout(1300)).toBe("fixed");
    expect(reviewPanelLayout(1301)).toBe("fixed");
  });

  // A container measuring 0 is hidden, not narrow — AgentMonitor keeps unselected sessions
  // mounted and hidden. Treating that as "narrow" would flip every background tab to overlay.
  it("has no opinion about a container that measures zero", () => {
    expect(reviewPanelLayout(0)).toBeNull();
    expect(reviewPanelLayout(-1)).toBeNull();
  });
});

describe("clampSidebarWidth", () => {
  it("holds the width inside the draggable range", () => {
    expect(clampSidebarWidth(255)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(701)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(400)).toBe(400);
  });

  it("falls back to the minimum for a value that is not a number", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe("stored preferences", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to an open panel at the minimum width", () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_MIN_WIDTH);
    expect(readPanelOpen()).toBe(true);
  });

  it("round-trips a stored width through the clamp", () => {
    localStorage.setItem("review:sidebarWidth", "420");
    expect(readSidebarWidth()).toBe(420);
  });

  // Hand-edited or corrupt storage must not reach the panel's initial size.
  it("sanitises a stored width that is out of range or junk", () => {
    localStorage.setItem("review:sidebarWidth", "9999");
    expect(readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH);
    localStorage.setItem("review:sidebarWidth", "not-a-number");
    expect(readSidebarWidth()).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("only treats an explicit false as collapsed", () => {
    localStorage.setItem("review:panelOpen", "false");
    expect(readPanelOpen()).toBe(false);
    localStorage.setItem("review:panelOpen", "true");
    expect(readPanelOpen()).toBe(true);
  });
});

// The measured container width, standing in for layout happy-dom does not do.
let containerWidth = 0;
let observerCallback: ResizeObserverCallback | null = null;

class StubResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(cb: ResizeObserverCallback) {
    observerCallback = cb;
  }
}

function resizeTo(width: number) {
  containerWidth = width;
  act(() => {
    observerCallback?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

/**
 * The hook wired up the way a host wires it. The ref has to be on a node before the layout effect
 * runs, or nothing is ever observed — which is what rules `renderHook` out here.
 */
function Harness({ dragTo = 480 }: { dragTo?: number }) {
  const {
    containerRef,
    layout,
    sidebarWidth,
    trackSidebarWidth,
    commitSidebarWidth,
    panelOpen,
    setPanelOpen,
  } = useReviewPanelLayout();
  return (
    <div
      ref={containerRef}
      data-testid="panel"
      data-layout={layout}
      data-open={String(panelOpen)}
      data-width={String(sidebarWidth)}
    >
      <button type="button" onClick={() => setPanelOpen(false)}>
        close
      </button>
      <button type="button" onClick={() => trackSidebarWidth(dragTo)}>
        drag
      </button>
      <button type="button" onClick={commitSidebarWidth}>
        release
      </button>
    </div>
  );
}

const state = () => screen.getByTestId("panel").dataset;
const press = (name: string) => userEvent.click(screen.getByRole("button", { name }));

describe("useReviewPanelLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    containerWidth = 0;
    observerCallback = null;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return containerWidth;
      },
    });
  });

  // The floating panel covers the diff it exists to navigate, so it is a thing you reach for
  // rather than a column you keep.
  it("closes the panel when the container narrows to the overlay layout", () => {
    render(<Harness />);
    expect(state().open).toBe("true");

    resizeTo(1000);
    expect(state().layout).toBe("overlay");
    expect(state().open).toBe("false");
  });

  it("restores the remembered state when the container widens again", () => {
    render(<Harness />);
    resizeTo(1000);
    resizeTo(1400);
    expect(state().layout).toBe("fixed");
    expect(state().open).toBe("true");
  });

  // Dismissing the overlay is not a preference — recording it would collapse the inline panel
  // the next time the review is opened wide.
  it("only records the open state from the inline layout", async () => {
    render(<Harness />);
    resizeTo(1000);
    await press("close");
    expect(localStorage.getItem("review:panelOpen")).toBeNull();

    resizeTo(1400);
    await press("close");
    expect(localStorage.getItem("review:panelOpen")).toBe("false");
  });

  /**
   * react-resizable-panels re-registers a panel whenever `defaultSize` changes, which re-applies
   * the layout — so a dragged width fed straight back into it fights the drag, and the handle
   * moves a pixel or two and stops. The width is only adopted once the pointer is released.
   */
  it("persists a drag without moving the size the panel opens at", async () => {
    render(<Harness />);
    const opensAt = state().width;

    await press("drag");
    expect(localStorage.getItem("review:sidebarWidth")).toBe("480");
    expect(state().width).toBe(opensAt);

    await press("release");
    expect(state().width).toBe("480");
  });

  it("clamps a dragged width to the draggable range", async () => {
    render(<Harness dragTo={9999} />);
    await press("drag");
    await press("release");
    expect(state().width).toBe(String(SIDEBAR_MAX_WIDTH));
  });
});

describe("estimateDiffHeight", () => {
  it("grows with the number of diff lines", () => {
    const short = estimateDiffHeight(["@@\n+one"]);
    const long = estimateDiffHeight([`@@\n${"+line\n".repeat(40)}`]);
    expect(long).toBeGreaterThan(short);
  });

  it("caps so one huge file cannot make the scrollbar meaningless", () => {
    expect(estimateDiffHeight([`@@\n${"+line\n".repeat(100000)}`])).toBeLessThanOrEqual(4000);
  });

  // An untracked file carries no hunks — its body is fetched, so the size is a guess either way,
  // but it must not be zero or the card falls inside the root margin immediately.
  it("returns a usable height with no hunks", () => {
    expect(estimateDiffHeight([])).toBeGreaterThan(100);
  });
});
