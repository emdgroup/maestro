import { describe, it, expect, beforeAll } from "vitest";
import { createRef } from "react";
import { render, act } from "@testing-library/react";
import { DiffView, DiffModeEnum, type DiffFile } from "@git-diff-view/react";
import { HUNK_ACTION_SELECTOR } from "./hunk-header-press";

/**
 * `HUNK_ACTION_SELECTOR` targets `@git-diff-view`'s own DOM, which is not public API. The other
 * tests exercise it against markup copied from the library's source; this one renders the real
 * component, so a bump that restructures the chunk-header row fails here rather than silently
 * leaving the affordance unclickable.
 *
 * Highlighting is off — Shiki contributes nothing to the row structure and costs seconds.
 */

const OLD = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

const DIFF =
  [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -17,7 +17,7 @@",
    " line 17",
    " line 18",
    " line 19",
    "-line 20",
    "+line 20 CHANGED",
    " line 21",
    " line 22",
    " line 23",
  ].join("\n") + "\n";

// The library sizes its line-number column by measuring text on a canvas, and happy-dom has no
// 2D context to give it — without this every render throws before producing a row.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  })) as unknown as HTMLCanvasElement["getContext"];
});

function renderDiff(mode: DiffModeEnum, withContent: boolean) {
  return render(
    <DiffView
      data={{
        oldFile: { fileName: "f.txt", fileLang: "text", content: withContent ? OLD : "" },
        newFile: { fileName: "f.txt", fileLang: "text", content: "" },
        hunks: [DIFF],
      }}
      diffViewMode={mode}
    />,
  );
}

describe("chunk-header markup", () => {
  // Both modes, because the stack renders either one and they are separate components upstream.
  it.each([
    ["unified", DiffModeEnum.Unified],
    ["split", DiffModeEnum.Split],
  ])("exposes an action cell in %s mode with no content attached", (_label, mode) => {
    const { container } = renderDiff(mode, false);
    expect(container.querySelector(HUNK_ACTION_SELECTOR)).not.toBeNull();
  });

  // The state the affordance is withdrawn in: the library now draws its own arrows in that cell,
  // so the selector still matching is expected — what must not happen is our listener staying
  // bound, which `ExpandableDiffViewer` handles by dropping the callback.
  it("still exposes the cell once content makes expansion available", () => {
    const { container } = renderDiff(DiffModeEnum.Unified, true);
    expect(container.querySelector(HUNK_ACTION_SELECTOR)).not.toBeNull();
    expect(container.querySelector('button[title="Expand Up"]')).not.toBeNull();
  });

  /**
   * `diff-expand.css` repaints revealed lines to match ordinary context, and it finds them by
   * `data-state="plain"` — the library's own marker for a row carrying no diff line. The
   * background it overrides is an inline style, so the rule cannot degrade gracefully: if this
   * marker moved, the seam would come back silently, and only in dark mode.
   */
  it.each([
    ["unified", DiffModeEnum.Unified],
    ["split", DiffModeEnum.Split],
  ])("marks lines revealed by an expansion as 'plain' in %s mode", async (_label, mode) => {
    const ref = createRef<{ getDiffFileInstance: () => DiffFile | null }>();
    const { container } = render(
      <DiffView
        ref={ref}
        data={{
          oldFile: { fileName: "f.txt", fileLang: "text", content: OLD },
          newFile: { fileName: "f.txt", fileLang: "text", content: "" },
          hunks: [DIFF],
        }}
        diffViewMode={mode}
      />,
    );

    // Only hunk content is on screen to begin with.
    expect(container.querySelectorAll('tr[data-state="plain"]')).toHaveLength(0);

    const file = ref.current?.getDiffFileInstance();
    expect(file).toBeTruthy();
    await act(async () => {
      const expand =
        mode === DiffModeEnum.Split
          ? file!.onSplitHunkExpand.bind(file)
          : file!.onUnifiedHunkExpand.bind(file);
      const total = file!.unifiedLineLength;
      for (let i = 0; i < total; i++) {
        const isHunk =
          mode === DiffModeEnum.Split ? file!.getSplitHunkLine(i) : file!.getUnifiedHunkLine(i);
        if (isHunk) expand("all", i);
      }
    });

    expect(container.querySelectorAll('tr[data-state="plain"]').length).toBeGreaterThan(0);
  });
});
