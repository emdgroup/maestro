import { describe, it, expect } from "vitest";
import { buildAnnotationBlocks } from "./build-annotation-prompt";
import type { Annotation } from "@/store/annotationStore";

function diff(id: string, filePath: string, lineNumber: number, text: string): Annotation {
  return { id, kind: "diff", filePath, lineNumber, side: "new", text };
}

describe("buildAnnotationBlocks", () => {
  it("returns nothing for an empty list", () => {
    expect(buildAnnotationBlocks([])).toEqual([]);
  });

  it("groups diff annotations by file with line numbers", () => {
    const blocks = buildAnnotationBlocks([
      diff("1", "src/git/merge.rs", 42, "handle leaks"),
      diff("2", "src/git/merge.rs", 7, "why unwrap"),
      diff("3", "src/lib.rs", 0, "file-level note"),
    ]);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("## `src/git/merge.rs`");
    expect(text).toContain("- line:42 — handle leaks");
    expect(text).toContain("- line:7 — why unwrap");
    expect(text).toContain("## `src/lib.rs`");
    // File-level annotations carry no line prefix.
    expect(text).toContain("- file-level note");
    expect(text.match(/## `src\/git\/merge\.rs`/g)).toHaveLength(1);
  });

  it("renders plan annotations as a quote plus the note", () => {
    const blocks = buildAnnotationBlocks([
      {
        id: "p1",
        kind: "plan",
        quote: "never overwrites\nan existing value",
        occurrence: 0,
        text: "null or missing?",
      },
    ]);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("## Plan");
    expect(text).toContain("> never overwrites an existing value");
    expect(text).toContain("null or missing?");
  });
});
