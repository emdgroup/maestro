/**
 * Review Types
 * Frontend-only types for review workflow (no ts-rs export needed)
 */

export type ReviewDecision = "Approve" | "RequestChanges";

export type DiffHighlighterLang =
  | "javascript"
  | "typescript"
  | "tsx"
  | "jsx"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "csharp"
  | "cpp"
  | "c"
  | "html"
  | "css"
  | "json"
  | "yaml"
  | "markdown"
  | "bash"
  | "shell"
  | "sql"
  | "xml"
  | string;

// Format expected by @git-diff-view/react
export interface DiffFile {
  oldFile?: {
    fileName?: string | null;
    fileLang?: DiffHighlighterLang | null;
    content?: string | null;
  };
  newFile?: {
    fileName?: string | null;
    fileLang?: DiffHighlighterLang | null;
    content?: string | null;
  };
  hunks: string[];
}

// Helper type for accessing file name from DiffFile
export interface DiffFileWithName extends DiffFile {
  fileName: string;
  status?: "A" | "M" | "D";
  /** Set for changes git describes without hunks (rename, binary, mode bits). */
  note?: string;
}

/**
 * One row of a review's file list. Modified and untracked files sit in the same sequence — an
 * untracked file has no diff to parse, so it carries its path and its content is fetched per file.
 */
export type DisplayItem =
  | { kind: "diff"; file: DiffFileWithName }
  | { kind: "untracked"; path: string };

/** The path a display item is keyed and labelled by. */
export function displayItemPath(item: DisplayItem): string {
  return item.kind === "diff" ? item.file.fileName : item.path;
}
