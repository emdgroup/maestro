import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { CanvasHtml } from "./CanvasHtml";
import { CanvasEventContext, type CanvasEventSink } from "./canvas-events";
import type { CanvasSurface } from "../types";

vi.mock("@/providers/ThemeProvider", () => ({
  useTheme: () => ({
    theme: "dark",
    systemTheme: "dark",
    effectiveAccentHue: 0,
    systemAccentHue: 0,
  }),
}));

vi.mock("@/lib/tauri-utils", () => ({ api: {} }));

const surface: CanvasSurface = {
  surfaceId: "s-1",
  title: "Latency",
  html: "<div id='root'>hi</div>",
  theme: "maestro",
  sources: [],
  data: {},
  createdAt: 0,
};

const sink: CanvasEventSink = { record: vi.fn(), emit: vi.fn() };

beforeEach(() => {
  (sink.record as ReturnType<typeof vi.fn>).mockReset();
  (sink.emit as ReturnType<typeof vi.fn>).mockReset();
});

function renderCanvas(over: Partial<CanvasSurface> = {}) {
  const result = render(
    <CanvasEventContext.Provider value={sink}>
      <CanvasHtml surface={{ ...surface, ...over }} />
    </CanvasEventContext.Provider>,
  );
  const iframe = result.container.querySelector("iframe") as HTMLIFrameElement;
  return { ...result, iframe };
}

/** Deliver a message as the frame would — the `source` check is the whole security boundary. */
function fromFrame(iframe: HTMLIFrameElement, data: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow }));
}

describe("CanvasHtml", () => {
  it("renders the agent's document in a frame that can never reach the app", () => {
    const { iframe } = renderCanvas();
    // `allow-same-origin` is the one that must never appear: with it the agent's script would run
    // on the app's origin, where `withGlobalTauri` exposes every IPC command. `allow-forms` is
    // required for the opposite reason — without it Chromium never fires `submit`, so the
    // bridge's `form[id]` wiring silently does nothing.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("srcdoc")).toContain("<div id='root'>hi</div>");
    // Relative URLs must not resolve against the app's own origin.
    expect(iframe.getAttribute("srcdoc")).toContain('<base href="about:blank">');
    expect(iframe.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("injects Tailwind for a themed surface and nothing for theme none", () => {
    expect(renderCanvas().iframe.getAttribute("srcdoc")).toContain('id="__mtw__"');
    expect(renderCanvas({ theme: "none" }).iframe.getAttribute("srcdoc")).not.toContain(
      'id="__mtw__"',
    );
  });

  it("forwards an event from its own frame to the sink", () => {
    const { iframe } = renderCanvas();
    fromFrame(iframe, { type: "canvas-event", id: "go", kind: "click", value: "x" });
    fromFrame(iframe, { type: "canvas-record", id: "branch", value: "main" });

    expect(sink.emit).toHaveBeenCalledWith("go", "click", "x");
    expect(sink.record).toHaveBeenCalledWith("branch", "main");
  });

  it("ignores an identical message from another window", () => {
    renderCanvas();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "canvas-event", id: "go", kind: "click" },
        source: window,
      }),
    );
    expect(sink.emit).not.toHaveBeenCalled();
  });

  it("shows what the frame failed at, and reports it upward", async () => {
    const onError = vi.fn();
    const { container } = render(<CanvasHtml surface={surface} onError={onError} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;

    fromFrame(iframe, {
      type: "canvas-error",
      message: "blocked: logo.png (img-src)",
      source: "csp",
    });
    fromFrame(iframe, { type: "canvas-error", message: "failed to load cdn.js", source: "script" });

    await waitFor(() => expect(container.textContent).toContain("2 problems in this canvas"));
    expect(container.textContent).toContain("blocked: logo.png (img-src)");
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
