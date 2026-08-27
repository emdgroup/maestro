import { describe, it, expect } from "vitest";
import { DiffFile } from "@git-diff-view/react";
import { scopeRangeToHunk } from "./scope-selection";

/**
 * A 60-line file changed in two places, so the built diff has two hunks with a gap between them.
 * Visible new-side line numbers are 4,5,6 and 49,50,51 — nothing in between was ever displayed,
 * which is the whole point of the clamp.
 */
const OLD = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
const NEW = OLD.replace("line 5\n", "line 5 X\n").replace("line 50\n", "line 50 Y\n");

const HUNKS = [
  "--- a/f.txt\n+++ b/f.txt\n" +
    "@@ -4,3 +4,3 @@\n line 4\n-line 5\n+line 5 X\n line 6\n" +
    "@@ -49,3 +49,3 @@\n line 49\n-line 50\n+line 50 Y\n line 51",
];

/** `withContent` is what a later hunk-expansion feature would supply; without it there are no
 *  hidden lines and contiguity is the only signal a hunk ended. */
function build(withContent: boolean) {
  const file = DiffFile.createInstance({
    oldFile: { fileName: "f.txt", fileLang: "text", content: withContent ? OLD : "" },
    newFile: { fileName: "f.txt", fileLang: "text", content: withContent ? NEW : "" },
    hunks: HUNKS,
  });
  file.init();
  file.buildUnifiedDiffLines();
  return file;
}

function scope(file: ReturnType<typeof build>, startLineNumber: number, endLineNumber: number) {
  return scopeRangeToHunk(file, { side: "new", startLineNumber, endLineNumber }, true);
}

describe("scopeRangeToHunk", () => {
  it("leaves a drag that stays inside one hunk alone", () => {
    expect(scope(build(false), 4, 6)).toEqual({
      side: "new",
      startLineNumber: 4,
      endLineNumber: 6,
    });
  });

  it("stops a downward drag at the end of the anchor's hunk", () => {
    expect(scope(build(false), 4, 51)).toEqual({
      side: "new",
      startLineNumber: 4,
      endLineNumber: 6,
    });
  });

  it("stops an upward drag at the start of the anchor's hunk", () => {
    expect(scope(build(false), 51, 4)).toEqual({
      side: "new",
      startLineNumber: 51,
      endLineNumber: 49,
    });
  });

  // Once a file carries its full content the gap becomes hidden lines rather than missing ones,
  // so the walk has to stop on `isHide` as well as on a line-number jump.
  it("stops at collapsed lines when the file carries its full content", () => {
    expect(scope(build(true), 4, 51)).toEqual({
      side: "new",
      startLineNumber: 4,
      endLineNumber: 6,
    });
  });

  /**
   * The reason the walk stops on `isHide` rather than on a hunk index: expanding a chunk header
   * un-hides the lines under it, and a drag through them has to keep going. Anything scoping by
   * hunk membership would clamp at 6 here and silently drop the lines the user just revealed.
   */
  it("follows a drag through lines a hunk expansion revealed", () => {
    const file = build(true);
    const hunkIndexes = [...Array(file.unifiedLineLength).keys()].filter((i) =>
      file.getUnifiedHunkLine(i),
    );
    expect(hunkIndexes.length, "the diff must render chunk headers to expand from").toBeGreaterThan(
      0,
    );
    for (const index of hunkIndexes) file.onUnifiedHunkExpand("all", index);

    // The gap between the two hunks is now real content, so nothing stops the walk before 51.
    expect(scope(file, 4, 51)).toEqual({ side: "new", startLineNumber: 4, endLineNumber: 51 });
  });

  it("declines to scope a drag that has not moved yet", () => {
    expect(scope(build(false), 4, 4)).toBeNull();
  });

  it("declines to scope from a line the diff never showed", () => {
    expect(scope(build(false), 30, 32)).toBeNull();
  });
});
