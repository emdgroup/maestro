import type { PendingComment } from "./DiffViewer";

export type ExtendData = {
  oldFile: Record<string, { data: PendingComment }>;
  newFile: Record<string, { data: PendingComment }>;
};

/**
 * Map pending comments onto DiffView's `extendData` shape (one comment per line/side).
 *
 * In review mode the result is always an object, never undefined: DiffView applies the prop with
 * `if (extendData) setExtendData(...)`, so an undefined value skips the update and leaves the last
 * deleted comment's widget rendered. An empty map is what removes it.
 */
export function buildExtendData(
  reviewMode: boolean | undefined,
  comments: PendingComment[] | undefined,
): ExtendData | undefined {
  if (!reviewMode) return undefined;
  const oldFile: ExtendData["oldFile"] = {};
  const newFile: ExtendData["newFile"] = {};
  for (const comment of comments ?? []) {
    if (comment.lineNumber === 0) continue;
    const target = comment.side === "old" ? oldFile : newFile;
    target[String(comment.lineNumber)] = { data: comment };
  }
  return { oldFile, newFile };
}
