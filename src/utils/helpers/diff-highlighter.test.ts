import { describe, it, expect, vi } from "vitest";
import { DiffFile, highlighter as bundledDefault } from "@git-diff-view/core";
import { getDiffHighlighter, highlightToHtml } from "./diff-highlighter";
import { githubPalette } from "./codemirror-github-theme";
import { LANGUAGE_BY_EXTENSION, LANGUAGE_BY_FILENAME } from "./diff-utils";

// `src/test/setup.ts` stubs the highlighter for every other suite; this one is about the real one.
vi.unmock("@/lib/diff-highlighter");

const HUNK =
  "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n";

function build() {
  return new DiffFile("a.ts", "", "a.ts", "", [HUNK], "typescript", "typescript");
}

/**
 * `@git-diff-view/core` imports its default highlighter from `@git-diff-view/lowlight` at module
 * scope, so lowlight is always what a `DiffView` falls back to. Ours only wins because
 * `DiffViewer` passes `registerHighlighter` on every render and refuses to render without it —
 * drop either and highlighting silently disappears rather than breaking.
 */
describe("which highlighter the diff view actually uses", () => {
  it("highlights nothing through the bundled lowlight, which is stubbed out", () => {
    expect(bundledDefault.name).toBe("lowlight");
    const file = build();
    file.init();
    // `lowlight-stub.ts` returns no tree, so the fallback never claims the file.
    expect(file._getHighlighterName()).toBe("");
  });

  it("uses lezer once registerHighlighter is passed", async () => {
    const lezer = await getDiffHighlighter();

    const file = build();
    file.initRaw();
    file.initSyntax({ registerHighlighter: lezer as never });

    // The name `DiffView` writes to `data-highlighter`, and the one every syntax template
    // compares against before reusing a line.
    expect(file._getHighlighterName()).toBe("lezer");
    // And it really produced tokens, not merely recorded itself as the owner.
    expect(file.getNewSyntaxLine(2)?.nodeList.length).toBeGreaterThan(1);
  });

  it("tokenizes the new side of a diff whose base another diff already highlighted", async () => {
    const lezer = await getDiffHighlighter();
    const base = "const a = 1;\nconst b = 2;\n";
    const diff = (b: string) =>
      `--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = ${b};\n`;
    const highlighted = (hunk: string) => {
      const file = new DiffFile("a.ts", base, "a.ts", "", [hunk], "typescript", "typescript");
      file.initRaw();
      // `DiffView` only calls `initSyntax` when the file does not already claim the highlighter.
      if (file._getHighlighterName() !== lezer.name) {
        file.initSyntax({ registerHighlighter: lezer as never });
      }
      return file;
    };

    highlighted(diff("3"));
    // The next poll: same base, different post-image.
    expect(highlighted(diff("4")).getNewSyntaxLine(2)?.nodeList.length).toBeGreaterThan(1);
  });

  // Every name `detectLanguage` can hand a diff has to reach a grammar, or that file renders plain.
  it.each([
    ...new Set([...Object.values(LANGUAGE_BY_EXTENSION), ...Object.values(LANGUAGE_BY_FILENAME)]),
  ])("has a grammar for %s once asked for it", async (lang) => {
    const lezer = await getDiffHighlighter(lang);
    expect(lezer.hasRegisteredCurrentLang(lang)).toBe(true);
  });
});

describe("highlightToHtml", () => {
  it("paints tokens in the editor's palette for the theme asked for", async () => {
    const dark = await highlightToHtml("const a = 1;", "typescript", true);
    const light = await highlightToHtml("const a = 1;", "typescript", false);
    expect(dark).toContain(`color:${githubPalette(true).keyword}`);
    expect(light).toContain(`color:${githubPalette(false).keyword}`);
  });

  // `.file-code-view` numbers lines by counting these, so a token spanning lines has to be split.
  it("wraps every line, including those inside a multi-line token", async () => {
    const html = await highlightToHtml("/* a\nb */\nconst c = 1;", "typescript", true);
    expect(html.match(/<span class="line">/g)).toHaveLength(3);
  });

  it("still frames a language it has no grammar for, uncoloured and escaped", async () => {
    const html = await highlightToHtml("<b>x</b>\ny", "no-such-language", true);
    expect(html).toContain('<span class="line">&lt;b&gt;x&lt;/b&gt;</span>');
    expect(html).not.toContain("<span style=");
  });

  it("loads a grammar from @codemirror/language-data on demand", async () => {
    const html = await highlightToHtml("[a]\nb = 1", "toml", true);
    expect(html).toContain('<span style="color:');
  });
});
