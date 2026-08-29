import { describe, it, expect } from "vitest";
import { buildDisplayItems, toPanelFiles } from "./useReviewItems";
import type { DiffFileWithName } from "@/types/review";

function diffFile(fileName: string, status: "A" | "M" | "D"): DiffFileWithName {
  return { fileName, status, newFile: { fileName }, hunks: [] };
}

describe("toPanelFiles", () => {
  /**
   * Untracked files were mapped to "A", which is what the diff view shows for a file whose every
   * line is new. But an added file is part of the change under review, while an untracked one is a
   * file nobody has told git about — possibly a build artefact the agent left behind. Reading them
   * as the same thing is what let the second hide among the first.
   */
  it("gives untracked files their own status rather than borrowing the added one", () => {
    const items = buildDisplayItems([diffFile("src/added.ts", "A")], ["dist/bundle.js"]);

    const byPath = new Map(toPanelFiles(items).map((f) => [f.fileName, f.status]));

    expect(byPath.get("src/added.ts")).toBe("A");
    expect(byPath.get("dist/bundle.js")).toBe("U");
  });

  it("keeps each tracked file's own status", () => {
    const items = buildDisplayItems(
      [diffFile("a.ts", "M"), diffFile("b.ts", "D"), diffFile("c.ts", "A")],
      [],
    );

    expect(
      toPanelFiles(items)
        .map((f) => f.status)
        .sort(),
    ).toEqual(["A", "D", "M"]);
  });

  // `parseDiffString` leaves `status` unset for anything it cannot classify; the panel still has to
  // render a dot for it.
  it("falls back to modified when a diff carries no status", () => {
    const items = buildDisplayItems(
      [{ fileName: "x.ts", newFile: { fileName: "x.ts" }, hunks: [] }],
      [],
    );

    expect(toPanelFiles(items)[0].status).toBe("M");
  });
});
