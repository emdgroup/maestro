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

export function parseDiffString(diffString: string): DiffFileWithName[] {
  const files: DiffFileWithName[] = [];
  const lines = diffString.split("\n");

  let currentFile: string | null = null;
  // Accumulates the raw hunk lines (from --- header through last content line)
  // for the current file. Will be joined into a single string.
  let currentHunkLines: string[] = [];
  let inHunk = false;
  let currentStatus: "A" | "M" | "D" = "M";
  // Set when the header describes a change that carries no hunks (rename, binary,
  // mode bits). Without it those files never reach the UI at all.
  let currentNote: string | null = null;

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
      hunks: currentHunkLines.length > 0 ? [currentHunkLines.join("\n")] : [],
      status: currentStatus,
      ...(currentNote ? { note: currentNote } : {}),
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
      currentNote = "Binary file";
    } else if (!inHunk && line.startsWith("old mode ")) {
      currentNote = "File mode changed";
    }
    // Capture the --- / +++ header lines that the library parser requires
    else if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
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

/**
 * Extract a single hunk as a valid unified diff patch string.
 * Takes the hunks[0] content from parseDiffString output and returns
 * a minimal patch for hunkIndex: "--- a/file\n+++ b/file\n@@ ... @@\nlines\n"
 */
export function extractHunkPatch(fileHunkContent: string, hunkIndex: number): string {
  if (!fileHunkContent) return "";
  const lines = fileHunkContent.split("\n");
  const headerLines: string[] = [];
  const hunkBlocks: string[][] = [];
  let currentBlock: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      headerLines.push(line);
    } else if (line.startsWith("@@")) {
      if (currentBlock) hunkBlocks.push(currentBlock);
      currentBlock = [line];
    } else if (currentBlock !== null) {
      currentBlock.push(line);
    }
  }
  if (currentBlock) hunkBlocks.push(currentBlock);

  const targetBlock = hunkBlocks[hunkIndex];
  if (!targetBlock) return "";
  return [...headerLines, ...targetBlock].join("\n") + "\n";
}

/**
 * Count the number of @@ hunk headers in a file diff string.
 * Used to determine indeterminate checkbox state.
 */
export function countHunks(hunkContent: string): number {
  if (!hunkContent) return 0;
  return (hunkContent.match(/^@@/gm) ?? []).length;
}
