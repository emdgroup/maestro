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
 * Parse unified diff string into DiffFile array
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
  let currentHunks: string[] = [];
  let inHunk = false;
  let currentStatus: "A" | "M" | "D" = "M";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of new file diff
    if (line.startsWith("diff --git")) {
      // Save previous file if exists
      if (currentFile && currentHunks.length > 0) {
        const lang = detectLanguage(currentFile);
        files.push({
          fileName: currentFile,
          newFile: {
            fileName: currentFile,
            fileLang: lang,
            content: "", // Content will be reconstructed from hunks
          },
          hunks: currentHunks,
          status: currentStatus,
        });
      }

      // Parse new file name from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        currentFile = match[2];
        currentHunks = [];
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
    // Hunk header line
    else if (line.startsWith("@@")) {
      inHunk = true;
      currentHunks.push(line);
    }
    // Content lines within hunk
    else if (inHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      currentHunks.push(line);
    }
    // End of hunk (blank line or new section)
    else if (inHunk && line === "") {
      inHunk = false;
    }
  }

  // Save last file
  if (currentFile && currentHunks.length > 0) {
    const lang = detectLanguage(currentFile);
    files.push({
      fileName: currentFile,
      newFile: {
        fileName: currentFile,
        fileLang: lang,
        content: "",
      },
      hunks: currentHunks,
      status: currentStatus,
    });
  }

  return files;
}

/**
 * Compute per-file insertion/deletion statistics from hunk lines.
 * Lines starting with "+" (but not "+++") count as insertions.
 * Lines starting with "-" (but not "---") count as deletions.
 */
export function computeFileStats(hunks: string[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of hunks) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
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
