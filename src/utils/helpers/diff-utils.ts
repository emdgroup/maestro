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
export function parseDiffString(diffString: string): DiffFileWithName[] {
  const files: DiffFileWithName[] = [];
  const lines = diffString.split("\n");

  let currentFile: string | null = null;
  // Accumulates the raw hunk lines (from --- header through last content line)
  // for the current file. Will be joined into a single string.
  let currentHunkLines: string[] = [];
  let inHunk = false;
  let currentStatus: "A" | "M" | "D" = "M";

  const flushFile = () => {
    if (!currentFile || currentHunkLines.length === 0) return;
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
      hunks: [currentHunkLines.join("\n")],
      status: currentStatus,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of new file diff
    if (line.startsWith("diff --git")) {
      flushFile();

      // Parse new file name from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        currentFile = match[2];
        currentHunkLines = [];
        inHunk = false;
        currentStatus = "M";
      }
    }
    // Detect new/deleted file mode before the first hunk
    else if (!inHunk && line.includes("new file mode")) {
      currentStatus = "A";
    } else if (!inHunk && line.includes("deleted file mode")) {
      currentStatus = "D";
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
    // Blank line ends the current hunk block but we stay in hunk-accumulation mode
    // (a file can have multiple hunk blocks separated by blank lines)
    else if (inHunk && line === "") {
      inHunk = false;
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
 * Extract file name from diff output
 * Handles: "diff --git a/path/file b/path/file"
 */
export function extractFileNames(diffString: string): string[] {
  const fileNames = new Set<string>();
  const lines = diffString.split("\n");

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        fileNames.add(match[2]);
      }
    }
  }

  return Array.from(fileNames);
}
