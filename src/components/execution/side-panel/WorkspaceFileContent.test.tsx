import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

// The markdown branch pulls in Shiki and react-markdown; these tests are about the html one.
vi.mock("@/components/execution/activity/MarkdownBlock", () => ({
  MarkdownBlock: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}));
vi.mock("@/store/projectStore", () => ({ useSelectedProject: () => ({ id: 1 }) }));

import { WorkspaceFileContent } from "./WorkspaceFileContent";

function renderContent(content: string, fileName: string) {
  return render(
    <WorkspaceFileContent content={content} isLoading={false} error={null} fileName={fileName} />,
  );
}

function frame(container: HTMLElement) {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("no iframe rendered");
  return iframe;
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("WorkspaceFileContent html preview", () => {
  it("renders the page in an iframe rather than as markdown", () => {
    const { container, queryByTestId } = renderContent("<h1>hi</h1>", "index.html");

    expect(frame(container)).toHaveAttribute("srcdoc", "<h1>hi</h1>");
    expect(queryByTestId("markdown")).toBeNull();
  });

  /**
   * Without `allow-same-origin` the page sits on an opaque origin and cannot reach
   * `parent.window.__TAURI__`. `withGlobalTauri` is on, so an agent-written page that could would
   * hold the whole IPC surface.
   */
  it("sandboxes the page away from the app's IPC bridge", () => {
    const { container } = renderContent("<script>1</script>", "index.html");

    expect(frame(container)).toHaveAttribute("sandbox", "allow-scripts");
  });

  it("still renders markdown as markdown", () => {
    const { container, getByTestId } = renderContent("# hi", "README.md");

    expect(container.querySelector("iframe")).toBeNull();
    expect(getByTestId("markdown")).toHaveTextContent("# hi");
  });

  /**
   * Every change to `srcDoc` reloads the frame, re-running its scripts and dropping its scroll
   * position, so the split view must not preview each keystroke.
   */
  it("holds the preview back until the typing stops", () => {
    const { container, rerender } = renderContent("<p>a</p>", "index.html");

    rerender(
      <WorkspaceFileContent
        content="<p>ab</p>"
        isLoading={false}
        error={null}
        fileName="index.html"
      />,
    );
    expect(frame(container)).toHaveAttribute("srcdoc", "<p>a</p>");

    act(() => void vi.advanceTimersByTime(400));
    expect(frame(container)).toHaveAttribute("srcdoc", "<p>ab</p>");
  });

  /** A debounce that also delayed opening a file would leave the previous page up for half a second. */
  it("shows a newly opened file at once, without waiting out the debounce", () => {
    const { container, rerender } = renderContent("<p>first</p>", "a.html");

    rerender(
      <WorkspaceFileContent
        content="<p>second</p>"
        isLoading={false}
        error={null}
        fileName="b.html"
      />,
    );

    expect(frame(container)).toHaveAttribute("srcdoc", "<p>second</p>");
  });
});
