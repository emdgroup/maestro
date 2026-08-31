import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRef } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffModeEnum } from "@git-diff-view/react";
import { setAutoIntersect, intersect, observedElements } from "@/test/intersection-observer";

// The stack's own wiring is what is under test, not the diff renderer — and the real one pulls in
// Shiki, plus a query for the file's pre-image that would need a QueryClient. The stub reports the
// per-file review props it was handed, which is the contract that matters here.
vi.mock("./ExpandableDiffViewer", () => ({
  ExpandableDiffViewer: ({
    comments,
    onAddComment,
    onSubmitComment,
    highlight,
  }: {
    comments?: Array<{ id: string; lineNumber: number }>;
    onAddComment?: (lineNumber: number, fromLineNumber: number, side: "old" | "new") => void;
    onSubmitComment?: (text: string) => void;
    highlight?: boolean;
  }) => (
    <div data-testid="diff-viewer" data-highlight={highlight ? "on" : "off"}>
      {(comments ?? []).map((c) => (
        <span key={c.id} data-testid="line-comment">
          {c.id}:{c.lineNumber}
        </span>
      ))}
      {/* Stands in for a drag over the gutter followed by a click on the widget's `+`. The two
          steps are separate because the range has to survive between them. */}
      <button onClick={() => onAddComment?.(18, 12, "new")}>select 12-18</button>
      <button onClick={() => onSubmitComment?.("tighten this loop")}>submit draft</button>
    </div>
  ),
}));

import { DiffFileStack, type DiffFileStackHandle, type DiffReviewApi } from "./DiffFileStack";
import { useAnnotationStore } from "@/store/annotationStore";
import type { DiffAnnotation } from "@/store/annotationStore";
import type { DisplayItem } from "@/types/review";

const SESSION = 42;

function diffItem(name: string): DisplayItem {
  return { kind: "diff", file: { fileName: name, hunks: [`@@ -1 +1 @@\n+${name}`], status: "M" } };
}

/** A file of a given size in diff lines, for exercising the review's rendering budget. */
function sizedDiffItem(name: string, lines: number): DisplayItem {
  const body = Array.from({ length: lines - 1 }, (_, line) => `+line ${line}`).join("\n");
  return { kind: "diff", file: { fileName: name, hunks: [`@@ -1 +1 @@\n${body}`], status: "M" } };
}

const onSubmitComment = vi.fn();
const onRemoveComment = vi.fn();
const onEditComment = vi.fn();
const onSelectedIndexChange = vi.fn();

function emptyReview(overrides: Partial<DiffReviewApi> = {}): DiffReviewApi {
  return {
    comments: [],
    onSubmitComment,
    onRemoveComment,
    onEditComment,
    ...overrides,
  };
}

function renderStack(
  items: DisplayItem[],
  review: DiffReviewApi,
  ref?: React.Ref<DiffFileStackHandle>,
) {
  return render(
    <DiffFileStack
      ref={ref}
      items={items}
      projectId={1}
      cwd="/tmp/wt"
      diffTarget={{ type: "Head" }}
      diffViewMode={DiffModeEnum.Unified}
      selectedIndex={0}
      onSelectedIndexChange={onSelectedIndexChange}
      viewedFiles={new Set()}
      onToggleViewed={() => {}}
      review={review}
    />,
  );
}

beforeEach(() => {
  onSubmitComment.mockClear();
  onRemoveComment.mockClear();
  onEditComment.mockClear();
  onSelectedIndexChange.mockClear();
});

describe("DiffFileStack", () => {
  it("renders a card per file", () => {
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview());
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("b.ts")).toBeTruthy();
  });

  it("submits a file comment as line 0", async () => {
    renderStack([diffItem("a.ts")], emptyReview());
    await userEvent.click(screen.getByRole("button", { name: "Add file comment" }));
    await userEvent.type(screen.getByPlaceholderText("Add a comment..."), "rename this");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onSubmitComment).toHaveBeenCalledWith("a.ts", 0, 0, "new", "rename this");
  });

  // Line 0 is the file's own note and is rendered by the card; anything else belongs in the diff.
  // `buildExtendData` drops line 0, so a leak here would make the note disappear entirely.
  it("keeps the file note out of the diff's line comments", async () => {
    const comments = [
      { id: "file", filePath: "a.ts", lineNumber: 0, side: "new" as const, text: "whole file" },
      { id: "line", filePath: "a.ts", lineNumber: 12, side: "new" as const, text: "this line" },
    ];
    renderStack([diffItem("a.ts")], emptyReview({ comments }));

    // The file note lives in the card, not the diff body, so it is there before any mount.
    expect(screen.getByText("whole file")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByTestId("line-comment").map((n) => n.textContent)).toEqual(["line:12"]),
    );
  });

  it("does not leak one file's comments into another's", async () => {
    const comments = [
      { id: "a1", filePath: "a.ts", lineNumber: 3, side: "new" as const, text: "in a" },
      { id: "b1", filePath: "b.ts", lineNumber: 4, side: "new" as const, text: "in b" },
    ];
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview({ comments }));
    await waitFor(() =>
      expect(screen.getAllByTestId("line-comment").map((n) => n.textContent)).toEqual([
        "a1:3",
        "b1:4",
      ]),
    );
  });

  // Every card opens expanded regardless of how many there are — the old >20 rule collapsed a
  // large review and made the reviewer click through each file.
  it("opens every file expanded regardless of count", async () => {
    renderStack(
      Array.from({ length: 30 }, (_, i) => diffItem(`f${i}.ts`)),
      emptyReview(),
    );
    await waitFor(() => expect(screen.getAllByTestId("diff-viewer")).toHaveLength(30));
  });

  /**
   * The reversal the whole design turns on. Building a diff's structure is under a millisecond a
   * file, so every one of them is in the document from the first frame and the stack reaches its
   * true height immediately. What waits is Shiki — 25–150ms a file — and colour changes no layout,
   * so it can arrive whenever without moving anything.
   *
   * Deferring the *body* is what the two previous attempts did, and it cannot be made to work: an
   * unbuilt card has no height, so every scroll target is computed against a document that is
   * about to change underneath it.
   */
  it("renders every diff immediately, in plain text", () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview());

    const viewers = screen.getAllByTestId("diff-viewer");
    expect(viewers).toHaveLength(2);
    expect(viewers.map((v) => v.dataset.highlight)).toEqual(["off", "off"]);
  });

  it("highlights a card once it comes near the viewport", async () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts")], emptyReview());
    expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("off");

    act(() => intersect(observedElements()));

    await waitFor(() => expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("on"));
  });

  // Colour is never taken back, so returning to a file costs nothing and no card is ever seen to
  // lose it. There is nothing to reclaim by dropping it — the DOM stays either way.
  it("keeps a card highlighted after it scrolls away", async () => {
    setAutoIntersect(false);
    renderStack([diffItem("a.ts")], emptyReview());

    act(() => intersect(observedElements()));
    await waitFor(() => expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("on"));

    act(() => intersect(observedElements(), false));

    expect(screen.getByTestId("diff-viewer").dataset.highlight).toBe("on");
  });

  /**
   * One a frame, not one batch. `DiffView` tokenises inside synchronous effects and React flushes
   * effects one component at a time without yielding, so a commit that starts five cards blocks
   * for the sum of all five and paints nothing until the last finishes.
   */
  it("colours cards one frame at a time rather than all at once", async () => {
    // Hand-driven frames. `act()` drains happy-dom's timer queue in one go, so against the real
    // `requestAnimationFrame` five cards light up together and the test would pass either way.
    const pending: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => pending.push(cb));
    const nextFrame = async () => {
      const callback = pending.shift();
      if (callback) await act(async () => void callback(0));
    };

    try {
      setAutoIntersect(false);
      renderStack(
        Array.from({ length: 5 }, (_, i) => diffItem(`f${i}.ts`)),
        emptyReview(),
      );
      const lit = () =>
        screen.getAllByTestId("diff-viewer").filter((v) => v.dataset.highlight === "on").length;

      act(() => intersect(observedElements()));
      // The observer callback books a frame; it does not colour anything itself.
      expect(lit()).toBe(0);

      await nextFrame();
      expect(lit()).toBe(1);
      await nextFrame();
      expect(lit()).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Comment navigation waits on a MutationObserver for the comment's node and gives up after a
  // couple of seconds. The node is always there now — every diff is rendered — so what navigation
  // has to force is only the colour, ahead of whatever the queue was working through.
  it("highlights a navigation target ahead of the queue", () => {
    setAutoIntersect(false);
    const ref = createRef<DiffFileStackHandle>();
    renderStack(
      Array.from({ length: 30 }, (_, i) => diffItem(`f${i}.ts`)),
      emptyReview(),
      ref,
    );
    const lit = () =>
      screen.getAllByTestId("diff-viewer").filter((v) => v.dataset.highlight === "on");
    expect(lit()).toHaveLength(0);

    act(() => ref.current?.navigateTo(20));

    expect(lit()).toHaveLength(1);
  });

  /**
   * The budget, and the one case it exists for. A generated file costs more than the rest of the
   * review together, so it waits to be asked for — and skipping it does not spend the budget, so
   * everything after it still renders. Nothing here is driven by scrolling: building a diff is
   * tens of milliseconds of layout, and doing that as the viewport reaches each card made every
   * scroll compete with it.
   */
  it("puts a file too large to render behind a button, and renders the rest", () => {
    renderStack([sizedDiffItem("lock.json", 40_000), diffItem("a.ts")], emptyReview());

    expect(screen.getByRole("button", { name: "Load diff" })).toBeTruthy();
    // Tolerant of the grouping separator, which `toLocaleString` picks per environment.
    expect(screen.getByText(/^40[^\d]?000 lines$/)).toBeTruthy();
    expect(screen.getAllByTestId("diff-viewer")).toHaveLength(1);
  });

  it("renders it once asked", async () => {
    renderStack([sizedDiffItem("lock.json", 40_000), diffItem("a.ts")], emptyReview());

    await userEvent.click(screen.getByRole("button", { name: "Load diff" }));

    expect(screen.getAllByTestId("diff-viewer")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();
  });

  // Navigating to a file is asking for it — otherwise stepping to a comment inside a deferred file
  // would scroll to a button, and the chevron would appear to do nothing.
  it("renders a deferred file when navigation lands on it", () => {
    const ref = createRef<DiffFileStackHandle>();
    renderStack([sizedDiffItem("lock.json", 40_000), diffItem("a.ts")], emptyReview(), ref);

    act(() => ref.current?.navigateTo(0));

    expect(screen.getAllByTestId("diff-viewer")).toHaveLength(2);
  });

  // The common case has to stay invisible: an agent's worktree diff is a handful of files, and
  // none of this should be observable there.
  it("renders an ordinary review in full, with nothing to click", () => {
    renderStack(
      Array.from({ length: 12 }, (_, i) => sizedDiffItem(`f${i}.ts`, 80)),
      emptyReview(),
    );

    expect(screen.getAllByTestId("diff-viewer")).toHaveLength(12);
    expect(screen.queryByRole("button", { name: "Load diff" })).toBeNull();
  });

  // The host sorts items into tree order; the stack must not reorder them, or the sidebar
  // highlight and the scroll position would disagree about which file is which.
  it("renders cards in the order given", () => {
    renderStack([diffItem("z.ts"), diffItem("a.ts"), diffItem("m.ts")], emptyReview());
    const names = screen.getAllByText(/\.ts$/).map((n) => n.textContent);
    expect(names).toEqual(["z.ts", "a.ts", "m.ts"]);
  });

  // Scrolling does not move the selection, so a click on the card is the only way to pick the file
  // you are already reading without going back out to the tree.
  it("selects a file when its card is clicked", async () => {
    renderStack([diffItem("a.ts"), diffItem("b.ts")], emptyReview());

    await userEvent.click(screen.getByText("b.ts"));

    expect(onSelectedIndexChange).toHaveBeenCalledWith(1);
  });
});

/**
 * The point of keeping two stores: a review comment is a verdict that moves a task, an annotation
 * is a message to a live session. The interaction is one implementation, so the same script has to
 * land in whichever store the host wired up.
 */
describe("DiffReviewApi against a real store", () => {
  beforeEach(() => {
    act(() => useAnnotationStore.getState().clearSession(SESSION));
  });

  function annotationReview(): DiffReviewApi {
    const diffs = useAnnotationStore.getState().getAnnotations(SESSION, "diff") as DiffAnnotation[];
    return {
      comments: diffs,
      onSubmitComment: (filePath, lineNumber, fromLineNumber, side, text) => {
        const existing = diffs.find(
          (a) => a.filePath === filePath && a.lineNumber === lineNumber && a.side === side,
        );
        if (existing)
          useAnnotationStore
            .getState()
            .updateAnnotation(SESSION, existing.id, text, fromLineNumber);
        else
          useAnnotationStore.getState().addAnnotation(SESSION, {
            id: crypto.randomUUID(),
            kind: "diff",
            filePath,
            lineNumber,
            fromLineNumber,
            side,
            text,
          });
      },
      onRemoveComment: (id) => useAnnotationStore.getState().removeAnnotations(SESSION, [id]),
      onEditComment: (id, text) =>
        useAnnotationStore.getState().updateAnnotation(SESSION, id, text),
    };
  }

  it("writes a file note into annotationStore as a line-0 diff annotation", async () => {
    renderStack([diffItem("src/acp/manager.rs")], annotationReview());

    await userEvent.click(screen.getByRole("button", { name: "Add file comment" }));
    await userEvent.type(screen.getByPlaceholderText("Add a comment..."), "split this up");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    const stored = useAnnotationStore
      .getState()
      .getAnnotations(SESSION, "diff") as DiffAnnotation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "diff",
      filePath: "src/acp/manager.rs",
      lineNumber: 0,
      side: "new",
      text: "split this up",
    });
  });

  // The click that opens the composer and the submit that closes it are separate events, so the
  // selected range only survives if the stack holds on to both line numbers in between.
  it("carries a selected range from the widget click through to the store", async () => {
    renderStack([diffItem("src/git/merge.rs")], annotationReview());
    // The diff body is what carries the widget, and it only mounts once its card is on screen.
    act(() => intersect(observedElements()));

    await userEvent.click(screen.getByRole("button", { name: "select 12-18" }));
    await userEvent.click(screen.getByRole("button", { name: "submit draft" }));

    const stored = useAnnotationStore
      .getState()
      .getAnnotations(SESSION, "diff") as DiffAnnotation[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      filePath: "src/git/merge.rs",
      lineNumber: 18,
      fromLineNumber: 12,
      side: "new",
      text: "tighten this loop",
    });
  });
});
