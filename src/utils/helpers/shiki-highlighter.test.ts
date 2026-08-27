import { describe, it, expect, vi } from "vitest";
import { DiffFile, highlighter as bundledDefault } from "@git-diff-view/core";
import { getDiffHighlighter } from "./shiki-highlighter";

const HUNK =
  "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n";

function build() {
  return new DiffFile("a.ts", "", "a.ts", "", [HUNK], "typescript", "typescript");
}

/**
 * `@git-diff-view/core` imports its default highlighter from `@git-diff-view/lowlight` at module
 * scope, so lowlight is always what a `DiffView` falls back to. Ours only wins because
 * `DiffViewer` passes `registerHighlighter` on every render and refuses to render without it —
 * drop either and highlighting silently regresses to lowlight rather than breaking.
 */
describe("which highlighter the diff view actually uses", () => {
  it("falls back to the bundled lowlight when nothing is registered", () => {
    expect(bundledDefault.name).toBe("lowlight");
    const file = build();
    file.init();
    expect(file._getHighlighterName()).toBe("lowlight");
  });

  it("uses shiki once registerHighlighter is passed", async () => {
    const shiki = await getDiffHighlighter();
    const getAST = vi.spyOn(shiki, "getAST");

    const file = build();
    file.initRaw();
    file.initSyntax({ registerHighlighter: shiki as never });

    // The name the wrapper writes to `data-highlighter`, and the one every syntax template
    // compares against before reusing a line.
    expect(file._getHighlighterName()).toBe("shiki");
    // And it is really being asked for tokens, not merely recorded as the owner.
    expect(getAST).toHaveBeenCalled();
    expect(getAST.mock.results[getAST.mock.results.length - 1]?.value).toBeDefined();
  });
});
