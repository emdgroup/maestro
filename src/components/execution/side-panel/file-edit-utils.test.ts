import { describe, it, expect } from "vitest";
import {
  canEditFile,
  decideSave,
  filePollInterval,
  folderLabel,
  parseMarkdownEditLayout,
  proportionalScrollTop,
  resolveMarkdownLayout,
  validateEntryName,
  FILE_POLL_INTERVAL_MS,
  MIN_SPLIT_PANE_PX,
} from "./file-edit-utils";

describe("parseMarkdownEditLayout", () => {
  it.each(["source", "split", "preview"] as const)("accepts the stored layout %s", (value) => {
    expect(parseMarkdownEditLayout(value)).toBe(value);
  });

  /**
   * The setting shares a free-text column with every other preference, so absent, blank and
   * unrecognised all have to land somewhere usable rather than blanking the pane.
   */
  it.each([null, undefined, "", "three-up", "SPLIT"])("falls back to source for %p", (value) => {
    expect(parseMarkdownEditLayout(value)).toBe("source");
  });
});

describe("resolveMarkdownLayout", () => {
  const wide = 1400;

  it("renders the chosen layout when there is room", () => {
    expect(resolveMarkdownLayout({ layout: "split", isMarkdown: true, availableWidth: wide })).toBe(
      "split",
    );
  });

  /** Two columns of ~300px are not a split view, they are two unreadable columns. */
  it("collapses split to source when the panel is too narrow", () => {
    expect(resolveMarkdownLayout({ layout: "split", isMarkdown: true, availableWidth: 600 })).toBe(
      "source",
    );
  });

  it("takes split at exactly two minimum panes and refuses one pixel under", () => {
    const exact = MIN_SPLIT_PANE_PX * 2;
    expect(
      resolveMarkdownLayout({ layout: "split", isMarkdown: true, availableWidth: exact }),
    ).toBe("split");
    expect(
      resolveMarkdownLayout({ layout: "split", isMarkdown: true, availableWidth: exact - 1 }),
    ).toBe("source");
  });

  /**
   * The stored preference is untouched by the collapse, so widening restores split by itself —
   * this is the render-time expression of that.
   */
  it("restores split once the panel is wide again", () => {
    const narrow = resolveMarkdownLayout({
      layout: "split",
      isMarkdown: true,
      availableWidth: 400,
    });
    const widened = resolveMarkdownLayout({
      layout: "split",
      isMarkdown: true,
      availableWidth: wide,
    });
    expect([narrow, widened]).toEqual(["source", "split"]);
  });

  it("leaves the single-pane layouts alone at any width", () => {
    expect(
      resolveMarkdownLayout({ layout: "preview", isMarkdown: true, availableWidth: 200 }),
    ).toBe("preview");
    expect(resolveMarkdownLayout({ layout: "source", isMarkdown: true, availableWidth: 200 })).toBe(
      "source",
    );
  });

  it("forces source for anything that is not markdown", () => {
    expect(
      resolveMarkdownLayout({ layout: "split", isMarkdown: false, availableWidth: wide }),
    ).toBe("source");
    expect(
      resolveMarkdownLayout({ layout: "preview", isMarkdown: false, availableWidth: wide }),
    ).toBe("source");
  });

  /**
   * Before the first measurement, assume the chosen layout fits — otherwise a user who picked
   * split sees a frame of source view on every open.
   */
  it("assumes split fits until the width has been measured", () => {
    expect(resolveMarkdownLayout({ layout: "split", isMarkdown: true, availableWidth: null })).toBe(
      "split",
    );
  });

  /**
   * An inactive side-panel tab is `hidden`, so it measures zero while its layout is perfectly
   * wide. Reading that as "too narrow" collapsed the pane for the frame before the tab was shown.
   */
  it("treats a zero width as not-yet-laid-out rather than too narrow", () => {
    expect(resolveMarkdownLayout({ layout: "split", isMarkdown: true, availableWidth: 0 })).toBe(
      "split",
    );
  });
});

describe("proportionalScrollTop", () => {
  const pane = { scrollHeight: 1000, clientHeight: 500 };

  it("puts a target twice as tall at twice the offset", () => {
    expect(
      proportionalScrollTop({
        scrollTop: 100,
        ...pane,
        targetScrollHeight: 1500,
        targetClientHeight: 500,
      }),
    ).toBe(200);
  });

  it("lands both panes on the top and the bottom together", () => {
    const ends = { targetScrollHeight: 3000, targetClientHeight: 500 };
    expect(proportionalScrollTop({ scrollTop: 0, ...pane, ...ends })).toBe(0);
    expect(proportionalScrollTop({ scrollTop: 500, ...pane, ...ends })).toBe(2500);
  });

  /**
   * Overscroll on a trackpad reports a scrollTop past the end; without the clamp the other pane
   * would be driven past its own bottom and snap back.
   */
  it("clamps an overscrolled or negative position", () => {
    const ends = { targetScrollHeight: 1500, targetClientHeight: 500 };
    expect(proportionalScrollTop({ scrollTop: 900, ...pane, ...ends })).toBe(1000);
    expect(proportionalScrollTop({ scrollTop: -40, ...pane, ...ends })).toBe(0);
  });

  /** A pane with nothing to scroll divides by zero; NaN assigned to scrollTop wipes the position. */
  it("yields zero rather than NaN when either pane cannot scroll", () => {
    expect(
      proportionalScrollTop({
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 400,
        targetScrollHeight: 1500,
        targetClientHeight: 500,
      }),
    ).toBe(0);
    expect(
      proportionalScrollTop({
        scrollTop: 100,
        ...pane,
        targetScrollHeight: 500,
        targetClientHeight: 500,
      }),
    ).toBe(0);
  });
});

describe("folderLabel", () => {
  it("names the workspace root in words rather than as an empty path", () => {
    expect(folderLabel("/work/repo", "/work/repo")).toBe("the workspace root");
  });

  it("shows a folder relative to the workspace, matching what the tree displays", () => {
    expect(folderLabel("/work/repo/src/components", "/work/repo")).toBe("src/components");
  });

  /**
   * The tree can be pointed at a path outside the workspace; an absolute path is the only
   * honest label there, and silently stripping a non-matching prefix would name the wrong folder.
   */
  it("falls back to the absolute path for somewhere outside the workspace", () => {
    expect(folderLabel("/etc/nginx", "/work/repo")).toBe("/etc/nginx");
  });

  it("does not mistake a sibling with a shared prefix for a child", () => {
    expect(folderLabel("/work/repo-other/src", "/work/repo")).toBe("/work/repo-other/src");
  });
});

describe("filePollInterval", () => {
  it("polls a visible file that is being viewed", () => {
    expect(filePollInterval({ hasError: false, isActive: true, mode: "view" })).toBe(
      FILE_POLL_INTERVAL_MS,
    );
  });

  /**
   * Without this the agent's next write lands in the query cache and replaces the buffer the user
   * is typing into. It is the reason `decideSave` has to exist at all.
   */
  it("stops polling in edit mode, so a refetch cannot replace the buffer being typed into", () => {
    expect(filePollInterval({ hasError: false, isActive: true, mode: "edit" })).toBe(false);
  });

  it("stops polling a tab that is off screen", () => {
    expect(filePollInterval({ hasError: false, isActive: false, mode: "view" })).toBe(false);
  });

  it("does not retry a read that already failed", () => {
    expect(filePollInterval({ hasError: true, isActive: true, mode: "view" })).toBe(false);
  });
});

describe("decideSave", () => {
  it("writes when the file is untouched since edit mode opened", () => {
    expect(decideSave({ baseline: "a", draft: "b", onDisk: "a" })).toEqual({ kind: "write" });
  });

  /**
   * The agent writing this file mid-edit is the normal case, not an exotic one — the panel stops
   * polling in edit mode precisely so the user's buffer is left alone, which is what makes this
   * check the only thing standing between them and a silently clobbered file.
   */
  it("reports a conflict when something else wrote the file", () => {
    expect(decideSave({ baseline: "a", draft: "b", onDisk: "agent wrote this" })).toEqual({
      kind: "conflict",
    });
  });

  it("treats a draft that already matches disk as nothing to do, even after an external write", () => {
    // The agent happened to produce exactly what the user typed. Reporting a conflict here would
    // ask them to choose between two identical files.
    expect(decideSave({ baseline: "a", draft: "b", onDisk: "b" })).toEqual({ kind: "unchanged" });
  });

  it("is unchanged when nothing was edited at all", () => {
    expect(decideSave({ baseline: "a", draft: "a", onDisk: "a" })).toEqual({ kind: "unchanged" });
  });

  it("does not confuse an empty file with a missing one", () => {
    expect(decideSave({ baseline: "", draft: "new", onDisk: "" })).toEqual({ kind: "write" });
    expect(decideSave({ baseline: "old", draft: "new", onDisk: "" })).toEqual({ kind: "conflict" });
  });
});

describe("canEditFile", () => {
  const base = { fileName: "src/main.ts", binaryMime: undefined, error: null, content: "hi" };

  it("offers editing for loaded text", () => {
    expect(canEditFile(base)).toBe(true);
  });

  it("refuses when no file is selected", () => {
    expect(canEditFile({ ...base, fileName: null })).toBe(false);
  });

  /**
   * The read view renders these through its mime branches and never loads text for them. Opening
   * an editor would show an empty buffer whose save would then truncate the real file.
   */
  it.each(["image/png", "application/pdf", "audio/mpeg", "video/mp4"])(
    "refuses binary content (%s)",
    (mime) => {
      expect(canEditFile({ ...base, binaryMime: mime, content: "base64…" })).toBe(false);
    },
  );

  it("refuses a file the read failed on, including too-large and binary refusals", () => {
    expect(canEditFile({ ...base, error: new Error("File too large"), content: null })).toBe(false);
    expect(canEditFile({ ...base, error: new Error("Binary file"), content: null })).toBe(false);
  });

  it("refuses while the content is still loading", () => {
    expect(canEditFile({ ...base, content: undefined })).toBe(false);
  });

  it("allows an empty file", () => {
    expect(canEditFile({ ...base, content: "" })).toBe(true);
  });
});

describe("validateEntryName", () => {
  it("accepts an ordinary name", () => {
    expect(validateEntryName("notes.md", ["src", "README.md"])).toBeNull();
  });

  it("trims before judging", () => {
    expect(validateEntryName("  notes.md  ", [])).toBeNull();
    expect(validateEntryName("   ", [])).toBe("Name cannot be empty");
  });

  it("rejects an empty name", () => {
    expect(validateEntryName("", [])).toBe("Name cannot be empty");
  });

  /** A name carrying a separator would silently write outside the folder the user picked. */
  it.each(["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"])(
    "rejects the separator or reserved character in %s",
    (name) => {
      expect(validateEntryName(name, [])).not.toBeNull();
    },
  );

  it("rejects the directory entries", () => {
    expect(validateEntryName(".", [])).not.toBeNull();
    expect(validateEntryName("..", [])).not.toBeNull();
  });

  it("rejects a name already taken in the destination", () => {
    expect(validateEntryName("src", ["src", "README.md"])).toContain("already exists");
  });

  it("allows a dotfile", () => {
    expect(validateEntryName(".gitignore", ["src"])).toBeNull();
  });

  /**
   * An unexpanded folder has no cached listing, so the dialog cannot check collisions and the
   * backend's own refusal is what protects the user.
   */
  it("passes anything unique when the sibling list is unknown", () => {
    expect(validateEntryName("src", [])).toBeNull();
  });
});
