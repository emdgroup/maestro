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

/** What a unified diff can say about a file: added, modified, deleted. */
export type DiffStatus = "A" | "M" | "D";

/**
 * What the file panel shows, which is one state wider than a diff can express.
 *
 * `U` is untracked — new on disk and never `git add`-ed. It used to be flattened to `A`, which
 * made a file the agent left behind look identical to one it deliberately added to the commit.
 */
export type FileStatus = DiffStatus | "U";

// Helper type for accessing file name from DiffFile
export interface DiffFileWithName extends DiffFile {
  fileName: string;
  status?: DiffStatus;
  /** Set for changes git describes without hunks (rename, binary, mode bits). */
  note?: string;
  /**
   * The path this file had at the diff's base, which is where its pre-image has to be looked up.
   * Differs from `fileName` for a rename, and is absent for a file the base does not have at all.
   */
  oldPath?: string;
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
