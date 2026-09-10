import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { useScrollSync } from "./useScrollSync";

/** happy-dom lays nothing out, so both scrollers are given their geometry by hand. */
function makeScroller(scrollHeight: number, clientHeight: number): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: clientHeight, configurable: true });
  element.scrollTop = 0;
  document.body.appendChild(element);
  return element;
}

function scroll(element: HTMLElement, top: number) {
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
}

function Harness({
  enabled,
  a,
  b,
}: {
  enabled: boolean;
  a: HTMLElement | null;
  b: HTMLElement | null;
}) {
  useScrollSync(enabled, a, b);
  return null;
}

let source: HTMLDivElement;
let preview: HTMLDivElement;

beforeEach(() => {
  document.body.innerHTML = "";
  // The preview renders twice as tall as the source can scroll: 500 of travel against 1000.
  source = makeScroller(1000, 500);
  preview = makeScroller(1500, 500);
});

describe("useScrollSync", () => {
  it("drives the preview from the source, in proportion", async () => {
    render(<Harness enabled a={source} b={preview} />);

    scroll(source, 250);

    await waitFor(() => expect(preview.scrollTop).toBe(500));
  });

  it("drives the source from the preview too", async () => {
    render(<Harness enabled a={source} b={preview} />);

    scroll(preview, 500);

    await waitFor(() => expect(source.scrollTop).toBe(250));
  });

  /**
   * Writing one pane's scrollTop fires the other's scroll event. Without the echo guard that
   * event mirrors straight back and the two panes fight, which shows up as a stuck or juddering
   * scroll rather than as an error.
   */
  it("does not bounce the originating pane back", async () => {
    render(<Harness enabled a={source} b={preview} />);

    scroll(source, 250);
    await waitFor(() => expect(preview.scrollTop).toBe(500));
    // The echo of that write, as the browser would deliver it.
    preview.dispatchEvent(new Event("scroll"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.scrollTop).toBe(250);
  });

  it("does nothing at all while disabled", async () => {
    render(<Harness enabled={false} a={source} b={preview} />);

    scroll(source, 250);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preview.scrollTop).toBe(0);
  });

  /**
   * The regression this hook shipped with: CodeMirror's scroller does not exist until its view is
   * constructed, so the element arrives after the first render. Reading it from a ref inside the
   * effect meant the listeners were never attached and scrolling did nothing.
   */
  it("attaches once a scroller that started null arrives", async () => {
    function Late() {
      const [b, setB] = useState<HTMLElement | null>(null);
      return (
        <>
          <Harness enabled a={source} b={b} />
          <button onClick={() => setB(preview)}>attach</button>
        </>
      );
    }
    const { getByRole } = render(<Late />);

    scroll(source, 250);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preview.scrollTop).toBe(0);

    act(() => getByRole("button").click());
    scroll(source, 250);

    await waitFor(() => expect(preview.scrollTop).toBe(500));
  });

  it("stops listening when it is torn down", async () => {
    const { unmount } = render(<Harness enabled a={source} b={preview} />);
    unmount();

    scroll(source, 250);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preview.scrollTop).toBe(0);
  });
});
