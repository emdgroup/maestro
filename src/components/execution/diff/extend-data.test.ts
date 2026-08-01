import { describe, it, expect } from "vitest";
import { buildExtendData } from "./extend-data";
import type { PendingComment } from "./DiffViewer";

function comment(id: string, lineNumber: number, side: "old" | "new" = "new"): PendingComment {
  return { id, filePath: "src/git/merge.rs", lineNumber, side, text: `note ${id}` };
}

describe("buildExtendData", () => {
  it("keeps an empty map in review mode so deleting the last comment clears its widget", () => {
    // Returning undefined here is the bug: DiffView does `if (extendData) setExtendData(...)`,
    // so the deleted comment's widget would stay on screen.
    expect(buildExtendData(true, [])).toEqual({ oldFile: {}, newFile: {} });
    expect(buildExtendData(true, undefined)).toEqual({ oldFile: {}, newFile: {} });
  });

  it("returns undefined outside review mode", () => {
    expect(buildExtendData(false, [comment("a", 4)])).toBeUndefined();
  });

  it("keys comments by line within their side and skips file-level ones", () => {
    const data = buildExtendData(true, [comment("a", 4), comment("b", 9, "old"), comment("c", 0)]);
    expect(Object.keys(data!.newFile)).toEqual(["4"]);
    expect(Object.keys(data!.oldFile)).toEqual(["9"]);
    expect(data!.newFile["4"].data.id).toBe("a");
  });
});
