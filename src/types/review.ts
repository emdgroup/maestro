/**
 * Review Types
 * Frontend-only types for review workflow (no ts-rs export needed)
 */

export type ReviewDecision = "Approve" | "RequestChanges";

export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  lineNum?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  fileName: string;
  oldContent?: string;
  newContent: string;
  hunks: DiffHunk[];
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
