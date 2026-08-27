import { describe, it, expect } from "vitest";
import { DiffFile } from "@git-diff-view/core";

/**
 * The library behaviour the whole hunk-expansion feature rests on.
 *
 * `@git-diff-view` only offers its chunk-header expand controls when `getExpandEnabled()` is true,
 * and that is false exactly while the `DiffFile` was composed from the diff alone. Handed one
 * side's full text it reconstructs the other by applying the patch, which is why Maestro fetches
 * only the pre-image rather than both sides.
 *
 * None of this is documented API, and a regression here is silent — the buttons would just stop
 * appearing, and no other test would notice. Hence pinning it directly against the library.
 */

const OLD_CONTENT = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const NEW_CONTENT = OLD_CONTENT.replace("line 20\n", "line 20 CHANGED\n");

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

function build(oldContent: string, newContent: string) {
  const file = new DiffFile("f.txt", oldContent, "f.txt", newContent, [DIFF], "txt", "txt");
  file.initRaw();
  file.buildUnifiedDiffLines();
  return file;
}

function countVisibleLines(file: ReturnType<typeof build>) {
  let visible = 0;
  for (let i = 0; i < file.unifiedLineLength; i++) {
    if (!file.getUnifiedLine(i)?.isHidden) visible++;
  }
  return visible;
}

describe("hunk expansion prerequisites", () => {
  // This is the state every Maestro diff was in before pre-image fetching existed, and the one it
  // falls back to whenever the blob cannot be fetched.
  it("is disabled when the file is composed from the diff alone", () => {
    expect(build("", "").getExpandEnabled()).toBe(false);
  });

  it("is enabled by the old side alone, and reconstructs the new side exactly", () => {
    const file = build(OLD_CONTENT, "");
    expect(file.getExpandEnabled()).toBe(true);
    expect(file._newFileContent).toBe(NEW_CONTENT);
  });

  // Not the direction Maestro uses, but it pins that one side is genuinely sufficient rather than
  // the old side being special-cased.
  it("is enabled by the new side alone, and reconstructs the old side exactly", () => {
    const file = build("", NEW_CONTENT);
    expect(file.getExpandEnabled()).toBe(true);
    expect(file._oldFileContent).toBe(OLD_CONTENT);
  });

  it("reveals lines the diff never carried when a hunk is expanded", () => {
    const file = build(OLD_CONTENT, "");
    const before = countVisibleLines(file);

    const hunkIndex = [...Array(file.unifiedLineLength).keys()].find((i) =>
      file.getUnifiedHunkLine(i),
    );
    expect(hunkIndex, "the diff must render a chunk header to expand from").toBeDefined();

    file.onUnifiedHunkExpand("up", hunkIndex!);
    expect(countVisibleLines(file)).toBeGreaterThan(before);
  });
});
