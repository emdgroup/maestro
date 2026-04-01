import { describe, expect, it } from "vitest";
import { parseDiffString, extractFileNames, computeFileStats } from "./diff-utils";

describe("extractFileNames", () => {
  it("returns empty array for empty string", () => {
    expect(extractFileNames("")).toEqual([]);
  });

  it("extracts single file name", () => {
    const diff = "diff --git a/src/foo.ts b/src/foo.ts\nindex abc..def 100644";
    expect(extractFileNames(diff)).toEqual(["src/foo.ts"]);
  });

  it("extracts multiple file names", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "diff --git a/src/b.tsx b/src/b.tsx",
      "diff --git a/README.md b/README.md",
    ].join("\n");
    expect(extractFileNames(diff)).toEqual(["src/a.ts", "src/b.tsx", "README.md"]);
  });

  it("deduplicates repeated file entries", () => {
    const diff = ["diff --git a/src/a.ts b/src/a.ts", "diff --git a/src/a.ts b/src/a.ts"].join(
      "\n",
    );
    expect(extractFileNames(diff)).toEqual(["src/a.ts"]);
  });

  it("ignores non-diff lines", () => {
    const diff = "index abc..def 100644\n--- a/src/a.ts\n+++ b/src/a.ts";
    expect(extractFileNames(diff)).toEqual([]);
  });
});

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

  it("handles blank line ending a hunk", () => {
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
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
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
    const hunks = [
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];
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
