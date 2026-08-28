/**
 * Unified Diff Parser
 * Converts raw unified diff string to @git-diff-view/react DiffFile format
 */

import { DiffFileWithName, DiffHighlighterLang } from "@/types/review";

/**
 * Detect file language based on file extension
 */
function detectLanguage(fileName: string): DiffHighlighterLang {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  const langMap: Record<string, DiffHighlighterLang> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    html: "html",
    htm: "html",
    css: "css",
    scss: "css",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    sql: "sql",
    xml: "xml",
  };

  return langMap[ext] || "text";
}

/**
 * Parse unified diff string into DiffFile array.
 *
 * The @git-diff-view/react library's `data.hunks` field is `string[]` where
 * each element is passed to an internal diff parser that requires a full
 * per-file diff header (`--- a/file\n+++ b/file\n`) followed by hunk blocks.
 * Therefore each element must be the complete diff text for one file, with
 * the `---`/`+++` header and all `@@` hunk blocks joined as a single string.
 *
 * Format:
 *   diff --git a/path/file b/path/file
 *   index ...
 *   --- a/path/file
 *   +++ b/path/file
 *   @@ -start,count +start,count @@ optional context
 *   context line
 *   -removed line
 *   +added line
 */
/**
 * Undo git's C-style path quoting. Non-ASCII bytes come through as octal escapes of the
 * UTF-8 encoding (`"caf\303\251.ts"`), so they have to be decoded as bytes, not characters.
 * A path that is not quoted is returned untouched.
 */
function unquoteGitPath(path: string): string {
  const quoted = path.match(/^"(.*)"$/);
  if (!quoted) return path;
  const body = quoted[1];
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      bytes.push(...encoder.encode(body[i]));
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r" };
    const next = body[i + 1] ?? "";
    bytes.push(...encoder.encode(escapes[next] ?? next));
    i += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Extract the post-image path from the remainder of a `diff --git` header.
 *
 * Paths containing spaces are emitted unquoted (`a/my file b/my file`), so the
 * split has to be on the LAST ` b/`; paths with non-ASCII bytes are emitted
 * quoted and backslash-escaped. Always returns a name — a null return would
 * leave the parser pointed at the previous file and silently append this
 * file's hunks to it.
 */
function parseGitHeaderPath(rest: string): string {
  const stripPrefix = (path: string) => (path.startsWith("b/") ? path.slice(2) : path);
  const bothQuoted = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
  if (bothQuoted) return stripPrefix(unquoteGitPath(bothQuoted[2]));
  const split = rest.lastIndexOf(" b/");
  if (split > 0) return stripPrefix(unquoteGitPath(rest.slice(split + 1)));
  return rest.trim();
}

/**
 * The pre-image path from a `--- ` header line, or null when the base has no such file.
 *
 * Git writes `--- /dev/null` for an addition and quotes non-ASCII paths the same way the
 * `diff --git` line does. This is read rather than derived from the file's own name because a
 * rename gives the two different values, and it is the old one that `git show <base>:<path>`
 * needs.
 */
function parseOldHeaderPath(rest: string): string | null {
  const trimmed = rest.trim();
  if (trimmed === "/dev/null") return null;
  const unquoted = unquoteGitPath(trimmed);
  return unquoted.startsWith("a/") ? unquoted.slice(2) : unquoted;
}

export function parseDiffString(diffString: string): DiffFileWithName[] {
  const files: DiffFileWithName[] = [];
  // Git terminates its output with a newline, so splitting yields a final empty element that is
  // an artifact rather than a line. Left in, it is pushed into the last file's hunk as a blank
  // context line — occupying a line number that belongs to real code and shifting everything
  // after it. A blank line *inside* a hunk is genuine content and is still preserved below.
  const lines = (diffString.endsWith("\n") ? diffString.slice(0, -1) : diffString).split("\n");

  let currentFile: string | null = null;
  // Accumulates the raw hunk lines (from --- header through last content line)
  // for the current file. Will be joined into a single string.
  let currentHunkLines: string[] = [];
  let inHunk = false;
  let currentStatus: "A" | "M" | "D" = "M";
  // Set when the header describes a change that carries no hunks (rename, binary,
  // mode bits). Without it those files never reach the UI at all.
  let currentNote: string | null = null;
  // The file's path at the diff's base, taken from the `---` header rather than assumed equal to
  // `currentFile`, which is the post-image name.
  let currentOldPath: string | null = null;

  const flushFile = () => {
    if (!currentFile) return;
    if (currentHunkLines.length === 0 && !currentNote) return;
    const lang = detectLanguage(currentFile);
    files.push({
      fileName: currentFile,
      newFile: {
        fileName: currentFile,
        fileLang: lang,
        content: "",
      },
      // The library parses each element of hunks[] as a full diff string.
      // A single joined string per file (containing --- / +++ / @@ blocks) is correct.
      //
      // The trailing newline is load-bearing. Without it the file's last diff line is parsed as
      // having no line terminator, and reconstructing the opposite side — which the library does
      // by concatenating `diffLine.text` — glues the following line onto it. That costs the
      // reconstructed side a line, so every expanded line below a file's last hunk renders
      // shifted by one. Git's own output ends with a newline; `split("\n")` above drops it.
      hunks: currentHunkLines.length > 0 ? [currentHunkLines.join("\n") + "\n"] : [],
      status: currentStatus,
      ...(currentNote ? { note: currentNote } : {}),
      ...(currentOldPath ? { oldPath: currentOldPath } : {}),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of new file diff
    if (line.startsWith("diff --git")) {
      flushFile();

      currentFile = parseGitHeaderPath(line.slice("diff --git".length).trim());
      currentHunkLines = [];
      inHunk = false;
      currentStatus = "M";
      currentNote = null;
      currentOldPath = null;
    }
    // Detect new/deleted file mode before the first hunk
    else if (!inHunk && line.includes("new file mode")) {
      currentStatus = "A";
    } else if (!inHunk && line.includes("deleted file mode")) {
      currentStatus = "D";
    }
    // Hunk-less changes: git describes them in the header and emits no @@ blocks
    else if (!inHunk && line.startsWith("rename to ")) {
      currentFile = unquoteGitPath(line.slice("rename to ".length));
    } else if (!inHunk && line.startsWith("rename from ")) {
      currentNote = `Renamed from ${unquoteGitPath(line.slice("rename from ".length))}`;
    } else if (!inHunk && (line.startsWith("Binary files ") || line === "GIT binary patch")) {
      // Phrased for the reader, not the parser: this is what the file's card shows in place of a
      // diff, and "Binary file" on its own reads as a truncated heading rather than an answer.
      currentNote = "Binary file. There is no line-by-line diff to show.";
    } else if (!inHunk && line.startsWith("old mode ")) {
      currentNote = "File mode changed";
    }
    // Capture the --- / +++ header lines that the library parser requires
    else if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      if (line.startsWith("--- ")) currentOldPath = parseOldHeaderPath(line.slice(4));
      currentHunkLines.push(line);
    }
    // Hunk header line
    else if (line.startsWith("@@")) {
      inHunk = true;
      currentHunkLines.push(line);
    }
    // Content lines within hunk
    else if (inHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      currentHunkLines.push(line);
    }
    // A blank line inside a hunk is preserved as hunk content.
    // An empty context line in the original source should be kept; the next
    // `diff --git` or `@@` header will correctly transition parser state.
    else if (inHunk && line === "") {
      currentHunkLines.push(line);
    }
  }

  // Save last file
  flushFile();

  return files;
}

/**
 * Parse a `git diff --shortstat` line into its three counts.
 *
 * Git omits whichever clauses are zero, so each is matched independently rather than the line
 * as a whole. Returns null when the string carries none of them, which is what an empty diff
 * looks like.
 */
export function parseDiffStat(
  raw: string | null,
): { files: number; insertions: number; deletions: number } | null {
  if (!raw) return null;
  const filesMatch = raw.match(/(\d+) files? changed/);
  const insMatch = raw.match(/(\d+) insertions?\(\+\)/);
  const delMatch = raw.match(/(\d+) deletions?\(-\)/);
  if (!filesMatch && !insMatch && !delMatch) return null;
  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

/**
 * Compute per-file insertion/deletion statistics from the hunks array.
 * Each element of hunks[] is a full multi-line diff string (--- / +++ / @@ blocks).
 * Lines starting with "+" (but not "+++") count as insertions.
 * Lines starting with "-" (but not "---") count as deletions.
 */
export function computeFileStats(hunks: string[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const hunkStr of hunks) {
    for (const line of hunkStr.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  return { insertions, deletions };
}
