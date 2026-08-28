import { describe, it, expect } from "vitest";
import { DiffFile } from "@git-diff-view/core";
import { parseDiffString } from "@/lib/diff-utils";

/**
 * Hunk expansion hands the library one side of a file and lets it rebuild the other from the
 * diff. That rebuild is only as good as the hunk string `parseDiffString` produces, and it fails
 * *quietly*: the library concatenates `diffLine.text` without re-adding terminators, so a hunk
 * string that misrepresents where lines end yields content that is silently short a line, and
 * every expanded line below that point renders shifted.
 *
 * Nothing else catches it. The library's own consistency check is behind
 * `process.env.NODE_ENV === "development"`, which vitest does not set, and the rendered diff rows
 * come from the diff itself rather than the reconstruction — so the corruption is invisible until
 * someone expands a hunk and reads the result.
 *
 * These assertions compare the rebuilt side against the real file byte for byte, which is the
 * only check that actually pins it.
 */

const OLD_LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const OLD = OLD_LINES.join("\n") + "\n";
const NEW = OLD.replace("line 5\n", "line 5 CHANGED\n").replace("line 25\n", "line 25 CHANGED\n");

/** Two hunks and a trailing newline — the shape `git diff` actually emits. */
const DIFF =
  [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -2,7 +2,7 @@",
    " line 2",
    " line 3",
    " line 4",
    "-line 5",
    "+line 5 CHANGED",
    " line 6",
    " line 7",
    " line 8",
    "@@ -22,7 +22,7 @@",
    " line 22",
    " line 23",
    " line 24",
    "-line 25",
    "+line 25 CHANGED",
    " line 26",
    " line 27",
    " line 28",
  ].join("\n") + "\n";

function build(oldContent: string, newContent: string) {
  const [file] = parseDiffString(DIFF);
  const diffFile = new DiffFile("f.txt", oldContent, "f.txt", newContent, file.hunks, "txt", "txt");
  diffFile.initRaw();
  diffFile.buildUnifiedDiffLines();
  return diffFile;
}

describe("hunk reconstruction", () => {
  // The failure this pins: without a terminator on the hunk string's last line, "line 28" and
  // "line 29" are concatenated, the rebuilt file is a line short, and expanded context below the
  // final hunk is off by one.
  it("rebuilds the new side byte for byte from the old", () => {
    expect(build(OLD, "")._newFileContent).toBe(NEW);
  });

  it("rebuilds the old side byte for byte from the new", () => {
    expect(build("", NEW)._oldFileContent).toBe(OLD);
  });

  // `split("\n")` on git's newline-terminated output leaves a final empty element. Pushed into
  // the last file's hunk it becomes a blank context line occupying a line number that belongs to
  // real code, which shifts everything after it.
  it("does not invent a trailing blank line from git's final newline", () => {
    const [file] = parseDiffString(DIFF);
    expect(file.hunks[0].endsWith("\n\n")).toBe(false);
    expect(file.hunks[0].endsWith("line 28\n")).toBe(true);
  });

  // Every line the diff claims for a side must be the line the real file has there. This is the
  // library's own `#checkFile`, run unconditionally rather than only under NODE_ENV=development.
  it("agrees with the real file on every line the diff names", () => {
    const bundle = build(OLD, "")._getFullBundle() as unknown as {
      oldFileDiffLines?: Record<string, { text: string }>;
      oldFilePlainLines?: Record<string, { value: string }>;
      newFileDiffLines?: Record<string, { text: string }>;
      newFilePlainLines?: Record<string, { value: string }>;
    };

    for (const side of ["old", "new"] as const) {
      const diffLines = bundle[`${side}FileDiffLines`] ?? {};
      const plainLines = bundle[`${side}FilePlainLines`] ?? {};
      for (const [lineNumber, diffLine] of Object.entries(diffLines)) {
        expect(plainLines[lineNumber]?.value, `${side} side disagrees at line ${lineNumber}`).toBe(
          diffLine.text,
        );
      }
    }
  });

  // A blank line inside a hunk is real content, and the trailing-artifact fix must not eat it.
  it("keeps a blank context line inside a hunk", () => {
    const diff =
      ["diff --git a/a.ts b/a.ts", "@@ -1,4 +1,4 @@", " one", "", " three", "-old", "+new"].join(
        "\n",
      ) + "\n";
    expect(parseDiffString(diff)[0].hunks[0]).toContain("\n\n");
  });
});
