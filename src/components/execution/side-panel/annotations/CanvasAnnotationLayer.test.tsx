import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, createEvent, waitFor } from "@testing-library/react";
import { CanvasAnnotationLayer } from "./CanvasAnnotationLayer";
import { useAnnotationStore, type CanvasAnnotation } from "@/store/annotationStore";
import type { CanvasSurface } from "@/components/execution/activity/types";

const captureRegion = vi.fn();
vi.mock("./canvas-capture", () => ({
  captureRegion: (...args: unknown[]) => captureRegion(...args),
}));

const SESSION = 42;

const surface: CanvasSurface = {
  surfaceId: "s-1",
  catalogId: "maestro-canvas/v1",
  title: "Latency review",
  components: [
    { id: "card", component: "Card", children: ["value"] },
    { id: "value", component: "Text", text: "42 ms" },
    { id: "chart", component: "Chart", type: "bar" },
  ],
  data: {},
};

/**
 * happy-dom lays nothing out, so every rect is zero and the hit-testing rules would have nothing
 * to work with. The geometry each element should claim is declared on it instead, which is enough
 * for `readNodes` — the one function that reads layout — to produce a real node list.
 */
const RECTS: Record<string, [number, number, number, number]> = {
  card: [0, 0, 200, 100],
  value: [10, 40, 100, 40],
  chart: [0, 120, 200, 100],
};

function Canvas() {
  return (
    <div>
      <span data-canvas-id="card" data-canvas-kind="Card" style={{ display: "contents" }}>
        <div data-rect="card">
          <span data-canvas-id="value" data-canvas-kind="Text" style={{ display: "contents" }}>
            <div data-rect="value">42 ms</div>
          </span>
        </div>
      </span>
      <span data-canvas-id="chart" data-canvas-kind="Chart" style={{ display: "contents" }}>
        <div data-rect="chart" />
      </span>
    </div>
  );
}

let originalGetRect: typeof Element.prototype.getBoundingClientRect;

beforeEach(() => {
  captureRegion.mockReset();
  useAnnotationStore.getState().clearSession(SESSION);
  originalGetRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const key = (this as HTMLElement).dataset?.rect;
    const spec = key ? RECTS[key] : undefined;
    // Anything unmarked is the layer's own chrome — the scroller, the frame, the overlay. They
    // stand in for the visible pane, which the marquee is clamped to, so zeroes would pin every
    // drag to a point.
    const [left, top, width, height] = spec ?? [0, 0, 1000, 1000];
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetRect;
});

function renderLayer(props: Partial<React.ComponentProps<typeof CanvasAnnotationLayer>> = {}) {
  return render(
    <CanvasAnnotationLayer
      sessionKey={SESSION}
      surface={surface}
      onSend={vi.fn()}
      onRequestSurface={vi.fn()}
      header={{ title: <span>Latency review</span>, actions: null }}
      {...props}
    >
      <Canvas />
    </CanvasAnnotationLayer>,
  );
}

/** The pointer-catching overlay only exists in annotation mode; entering it is a click away. */
function enterMode(container: HTMLElement): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /annotate this canvas/i }));
  const overlay = container.querySelector(".cursor-crosshair");
  if (!overlay) throw new Error("annotation mode did not arm");
  return overlay as HTMLElement;
}

function annotations() {
  return useAnnotationStore.getState().getAnnotations(SESSION, "canvas") as CanvasAnnotation[];
}

describe("CanvasAnnotationLayer", () => {
  it("does not intercept the canvas until the mode is entered", () => {
    const { container } = renderLayer();
    expect(container.querySelector(".cursor-crosshair")).toBeNull();
  });

  it("anchors a click to the card rather than the text inside it", async () => {
    const { container } = renderLayer();
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0 });

    const field = await screen.findByPlaceholderText(/leave a comment/i);
    fireEvent.change(field, { target: { value: "this tile is wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(annotations()).toHaveLength(1));
    const [note] = annotations();
    expect(note).toMatchObject({
      kind: "canvas",
      surfaceId: "s-1",
      surfaceTitle: "Latency review",
      componentIds: ["card"],
      text: "this tile is wrong",
    });
  });

  it("drills past the card to the text when Alt is held", async () => {
    const { container } = renderLayer();
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0, altKey: true });

    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "wrong units" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(annotations()[0].componentIds).toEqual(["value"]));
  });

  it("does not capture for a click", async () => {
    const { container } = renderLayer({ canCapture: true });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0 });

    await screen.findByPlaceholderText(/leave a comment/i);
    expect(captureRegion).not.toHaveBeenCalled();
  });

  it("marquees every component the drag touches and captures the region", async () => {
    captureRegion.mockResolvedValue({ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,x" });
    const { container } = renderLayer({ canCapture: true });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 200, button: 0 });

    await waitFor(() => expect(captureRegion).toHaveBeenCalledTimes(1));

    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "layout is upside down" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(annotations()).toHaveLength(1));
    const [note] = annotations();
    // The card is covered and the chart only clipped — both are selected, and neither is reduced
    // away since they are siblings.
    expect(note.kind === "canvas" && [...note.componentIds].sort()).toEqual(["card", "chart"]);
    expect(note.kind === "canvas" && note.shotPath).toBe("/tmp/shot.png");
  });

  it("outlines what the drag has caught before the comment is written", async () => {
    captureRegion.mockResolvedValue(null);
    const { container } = renderLayer();
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    // Still mid-drag: nothing has been submitted, but the catch is already shown.
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });

    await waitFor(() =>
      expect(container.querySelectorAll(".border-accent").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("shows the capture again when a saved note is reopened", async () => {
    captureRegion.mockResolvedValue({ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,x" });
    const { container } = renderLayer({ canCapture: true });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 200, button: 0 });
    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "look at this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0].shotDataUrl).toBe("data:image/png;base64,x");

    // Reopen it by clicking its region — the capture has to come back with it.
    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0 });
    const shot = await screen.findByAltText(/region this comment was left on/i);
    expect(shot).toHaveAttribute("src", "data:image/png;base64,x");
  });

  it("keeps the capture on screen while the note is edited, and can drop it", async () => {
    captureRegion.mockResolvedValue({ path: "/tmp/shot.png", dataUrl: "data:image/png;base64,x" });
    const { container } = renderLayer({ canCapture: true });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 200, button: 0 });
    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "first draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(annotations()).toHaveLength(1));

    // Reopen, then edit.
    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.click(await screen.findByTitle("Edit"));

    // Still visible while the text is rewritten, and as the same chip it was created with.
    expect(await screen.findByAltText("Region capture")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/remove the screenshot/i));
    await waitFor(() => expect(annotations()[0].shotDataUrl).toBeUndefined());
    expect(annotations()[0].shotPath).toBeUndefined();
    // The note itself survives losing its capture.
    expect(annotations()[0].text).toContain("first draft");
    expect(annotations()[0].componentIds.length).toBeGreaterThan(0);
  });

  it("says so when the region could not be captured", async () => {
    captureRegion.mockResolvedValue(null);
    const { container } = renderLayer({ canCapture: true });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 200, button: 0 });

    expect(await screen.findByText(/could not be captured/i)).toBeInTheDocument();
  });

  it("finishes a drag that leaves the pane", async () => {
    captureRegion.mockResolvedValue(null);
    const { container } = renderLayer();
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    // The pointer crosses the panel edge — the movement someone makes to reach a component sitting
    // against it — and the gesture is released out there, never over the overlay again.
    fireEvent.mouseLeave(overlay);
    fireEvent.mouseMove(window, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(window, { clientX: 150, clientY: 200, button: 0 });

    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "caught the edge" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(annotations()).toHaveLength(1));
    expect([...annotations()[0].componentIds].sort()).toEqual(["card", "chart"]);
  });

  it("suppresses the browser's own text selection while dragging", () => {
    const { container } = renderLayer();
    const overlay = enterMode(container);

    const down = createEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent(overlay, down);
    // Without this the drag becomes a text selection of whatever sits behind the canvas.
    expect(down.defaultPrevented).toBe(true);
  });

  it("keeps the note when the capture fails", async () => {
    captureRegion.mockResolvedValue(null);
    const { container } = renderLayer({ canCapture: true });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 200, button: 0 });

    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "still worth saying" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(annotations()).toHaveLength(1));
    expect(annotations()[0].kind === "canvas" && annotations()[0].text).toContain(
      "still worth saying",
    );
  });

  it("does not capture at all when the agent takes no images", async () => {
    const { container } = renderLayer({ canCapture: false });
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 200 });
    fireEvent.mouseUp(overlay, { clientX: 150, clientY: 200, button: 0 });

    await screen.findByPlaceholderText(/leave a comment/i);
    expect(captureRegion).not.toHaveBeenCalled();
  });

  it("snapshots the annotated components as JSON", async () => {
    const { container } = renderLayer();
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.change(await screen.findByPlaceholderText(/leave a comment/i), {
      target: { value: "note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(annotations()).toHaveLength(1));
    const [note] = annotations();
    expect(note.kind === "canvas" && note.subtree).toContain('"id": "value"');
  });

  it("leaves the mode on Escape once nothing is open", async () => {
    const { container } = renderLayer();
    const overlay = enterMode(container);

    fireEvent.mouseDown(overlay, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.mouseUp(overlay, { clientX: 50, clientY: 50, button: 0 });
    await screen.findByPlaceholderText(/leave a comment/i);

    // First Escape closes the composer…
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/leave a comment/i)).not.toBeInTheDocument(),
    );
    expect(container.querySelector(".cursor-crosshair")).not.toBeNull();

    // …the second leaves the mode.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".cursor-crosshair")).toBeNull());
  });
});
