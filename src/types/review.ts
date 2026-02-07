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
}

// For internal diff parsing, before converting to DiffFile format
export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  lineNum?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ReviewFeedback {
  taskId: number;
  decision: ReviewDecision;
  generalFeedback?: string;
  perFileComments?: Array<{
    filePath: string;
    comment: string;
  }>;
}
