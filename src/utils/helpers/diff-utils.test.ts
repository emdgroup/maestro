import { describe, expect, it } from "vitest";
import { parseDiffString, computeFileStats } from "./diff-utils";

describe("parseDiffString", () => {
  it("returns empty array for empty string", () => {
    expect(parseDiffString("")).toEqual([]);
  });

  it("parses a single file diff", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc..def 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " existing line",
      "-removed line",
      "+added line",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("src/foo.ts");
    expect(result[0].newFile?.fileName).toBe("src/foo.ts");
    expect(result[0].hunks[0]).toContain("@@ -1,3 +1,4 @@");
    expect(result[0].hunks[0]).toContain("-removed line");
    expect(result[0].hunks[0]).toContain("+added line");
  });

  it("parses multiple file diffs", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.tsx b/src/b.tsx",
      "@@ -5 +5 @@",
      "-removed",
      "+inserted",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe("src/a.ts");
    expect(result[1].fileName).toBe("src/b.tsx");
  });

  it("detects language from file extension", () => {
    const cases: Array<[string, string]> = [
      ["src/foo.ts", "typescript"],
      ["src/bar.tsx", "tsx"],
      ["main.rs", "rust"],
      ["script.py", "python"],
      ["style.css", "css"],
      ["app.json", "json"],
      ["unknown.xyz", "text"],
    ];

    for (const [filename, expectedLang] of cases) {
      const diff = [`diff --git a/${filename} b/${filename}`, "@@ -1 +1 @@", "+line"].join("\n");

      const result = parseDiffString(diff);
      expect(result[0]?.newFile?.fileLang).toBe(expectedLang);
    }
  });

  it("skips files with no hunks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index abc..def 100644",
      // no hunk follows
    ].join("\n");

    expect(parseDiffString(diff)).toHaveLength(0);
  });

  it("captures hunk header and content lines", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -10,4 +10,5 @@ function foo() {",
      " context line",
      "-old impl",
      "+new impl",
      "+extra line",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result[0]?.hunks[0]).toContain("@@ -10,4 +10,5 @@ function foo() {");
    expect(result[0]?.hunks[0]).toContain(" context line");
    expect(result[0]?.hunks[0]).toContain("-old impl");
    expect(result[0]?.hunks[0]).toContain("+new impl");
  });

  it("handles blank line between two file diffs", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
      "+added",
      "",
      "diff --git a/src/b.ts b/src/b.ts",
      "@@ -1 +1 @@",
      "+other",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(2);
    // blank line should not bleed into second file
    expect(result[1].fileName).toBe("src/b.ts");
  });

  it("emits an entry for a rename with no content change", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("src/new.ts");
    expect(result[0].hunks).toEqual([]);
    expect(result[0].note).toBe("Renamed from src/old.ts");
  });

  it("emits an entry for a binary file", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index abc..def 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("logo.png");
    expect(result[0].note).toBe("Binary file. There is no line-by-line diff to show.");
  });

  it("emits an entry for a mode-only change", () => {
    const diff = ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].note).toBe("File mode changed");
  });

  it("parses a path containing spaces", () => {
    const diff = [
      "diff --git a/docs/my notes.md b/docs/my notes.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("docs/my notes.md");
  });

  it("parses a quoted, escaped path", () => {
    const diff = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "+added",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].fileName).toBe("src/café.ts");
  });

  it("does not leak hunks into the previous file when a header is unrecognized", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
      "+first",
      "diff --git weird-header-without-prefixes",
      "@@ -1 +1 @@",
      "+second",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe("src/a.ts");
    expect(result[0].hunks[0]).not.toContain("+second");
  });

  it("preserves blank context lines within a hunk", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1,4 +1,4 @@",
      " line one",
      "",
      " line three",
      "-old",
      "+new",
    ].join("\n");

    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    // blank line inside the hunk must be preserved in the output
    expect(result[0].hunks[0]).toContain("\n\n");
  });
});

/**
 * `oldPath` is what `git show <base>:<path>` is given to fetch a file's pre-image, which is what
 * enables the diff view's hunk-expansion controls. Getting it wrong is silent — the fetch misses
 * and the controls simply never appear — so each shape git can emit is pinned here.
 */
describe("parseDiffString old path", () => {
  it("reads the pre-image path from the --- header", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(parseDiffString(diff)[0].oldPath).toBe("src/a.ts");
  });

  it("keeps the old name for a rename that also changed content", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const [file] = parseDiffString(diff);
    expect(file.fileName).toBe("src/new.ts");
    expect(file.oldPath).toBe("src/old.ts");
  });

  it("leaves it unset for an added file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/a.ts",
      "@@ -0,0 +1 @@",
      "+added",
    ].join("\n");

    expect(parseDiffString(diff)[0].oldPath).toBeUndefined();
  });

  it("unquotes a non-ASCII pre-image path", () => {
    const diff = [
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
      '--- "a/src/caf\\303\\251.ts"',
      '+++ "b/src/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(parseDiffString(diff)[0].oldPath).toBe("src/café.ts");
  });

  it("keeps a pre-image path containing spaces intact", () => {
    const diff = [
      "diff --git a/docs/my notes.md b/docs/my notes.md",
      "--- a/docs/my notes.md",
      "+++ b/docs/my notes.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    expect(parseDiffString(diff)[0].oldPath).toBe("docs/my notes.md");
  });

  it("does not carry one file's pre-image path onto the next", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1 @@",
      "+added",
    ].join("\n");

    const files = parseDiffString(diff);
    expect(files).toHaveLength(2);
    expect(files[0].oldPath).toBe("src/a.ts");
    expect(files[1].oldPath).toBeUndefined();
  });
});

describe("parseDiffString status detection", () => {
  it("returns status 'A' for new file mode", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");
    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("A");
  });

  it("returns status 'D' for deleted file mode", () => {
    const diff = [
      "diff --git a/old.ts b/old.ts",
      "deleted file mode 100644",
      "index abc1234..0000000",
      "--- a/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
    ].join("\n");
    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("D");
  });

  it("returns status 'M' for regular modification", () => {
    const diff = [
      "diff --git a/mod.ts b/mod.ts",
      "index abc..def 100644",
      "--- a/mod.ts",
      "+++ b/mod.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old line",
      "+new line",
    ].join("\n");
    const result = parseDiffString(diff);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("M");
  });

  it("defaults to 'M' when no mode line present", () => {
    const diff = ["diff --git a/file.ts b/file.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n");
    const result = parseDiffString(diff);
    expect(result[0].status).toBe("M");
  });
});

describe("computeFileStats", () => {
  it("returns zeros for empty hunks", () => {
    expect(computeFileStats([])).toEqual({ insertions: 0, deletions: 0 });
  });

  it("counts insertions and deletions", () => {
    const hunks = [
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed line",
      "+added line",
      "+extra line",
    ];
    expect(computeFileStats(hunks)).toEqual({ insertions: 2, deletions: 1 });
  });

  it("ignores +++ and --- header lines if present", () => {
    const hunks = ["--- a/file.ts", "+++ b/file.ts", "@@ -1 +1 @@", "-old", "+new"];
    expect(computeFileStats(hunks)).toEqual({ insertions: 1, deletions: 1 });
  });

  it("counts only additions", () => {
    const hunks = ["@@ -0,0 +1,3 @@", "+line1", "+line2", "+line3"];
    expect(computeFileStats(hunks)).toEqual({ insertions: 3, deletions: 0 });
  });

  it("counts only deletions", () => {
    const hunks = ["@@ -1,2 +0,0 @@", "-line1", "-line2"];
    expect(computeFileStats(hunks)).toEqual({ insertions: 0, deletions: 2 });
  });
});
