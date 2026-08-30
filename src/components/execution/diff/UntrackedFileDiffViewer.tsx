import { useMemo, useState } from "react";
import { DiffModeEnum } from "@git-diff-view/react";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { DiffViewer, type PendingComment } from "./DiffViewer";
import { fileNote } from "./ReviewFileCard";
import { LoadDiffPrompt } from "./LoadDiffPrompt";
import { diffLineCount, MAX_EAGER_FILE_LINES } from "./body-budget";
import { useUntrackedFileContentQuery } from "@/services/worktree.service";

interface UntrackedFileDiffViewerProps {
  projectId: number | null;
  worktreePath: string | null;
  filePath: string | null;
  showHeader?: boolean;
  // Review mode props
  reviewMode?: boolean;
  comments?: PendingComment[];
  activeCommentLine?: { lineNumber: number; side: "old" | "new" } | null;
  onAddComment?: (lineNumber: number, fromLineNumber: number, side: "old" | "new") => void;
  onRemoveComment?: (commentId: string) => void;
  onEditComment?: (commentId: string, newText: string) => void;
  onCancelComment?: () => void;
  onSubmitComment?: (text: string) => void;
  onSendComment?: (commentId: string) => void;
  commentNav?: React.ComponentProps<typeof DiffViewer>["commentNav"];
  sendDisabled?: boolean;
  /** See `DiffViewer`. A stack colours its cards as they near the viewport. */
  highlight?: boolean;
}

export function UntrackedFileDiffViewer({
  projectId,
  worktreePath,
  filePath,
  showHeader = true,
  reviewMode,
  comments,
  activeCommentLine,
  onAddComment,
  onRemoveComment,
  onEditComment,
  onCancelComment,
  onSubmitComment,
  onSendComment,
  commentNav,
  sendDisabled,
  highlight,
}: UntrackedFileDiffViewerProps) {
  const { data, isLoading } = useUntrackedFileContentQuery(projectId, worktreePath, filePath);

  const diffFile = useMemo(() => {
    if (!data) return null;
    return parseDiffString(data)[0] ?? null;
  }, [data]);

  /**
   * What to say instead of a diff.
   *
   * A new file reaches this component as `git diff --no-index /dev/null <path>`, and for a binary
   * one git answers with a header line and no hunks at all. Handed that, the diff view renders an
   * empty frame under the file's header — which reads as a broken card rather than as "there is
   * nothing here to read line by line". Tracked files already take this path through
   * `ReviewFileCard`; only the untracked ones went without it.
   */
  const note = isLoading
    ? undefined
    : diffFile
      ? fileNote(diffFile)
      : "There is no line-by-line diff to show for this file.";

  /**
   * The size cap, applied here rather than by the stack.
   *
   * An untracked file's body is fetched, not derived from the diff, so its size is unknown until
   * it arrives — the stack has to plan the whole review before that. Left uncapped, a few thousand
   * lines of untracked text rendered in full while ordinary tracked files sat behind a button,
   * which is both the wrong way round and where the freeze on opening a worktree diff came from.
   */
  const [requested, setRequested] = useState(false);
  const tooLarge =
    !requested && diffFile !== null && diffLineCount(diffFile.hunks) > MAX_EAGER_FILE_LINES;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {showHeader && diffFile && (
        <div className="px-3 py-2 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
          <span className="font-mono text-foreground truncate flex-1">{diffFile.fileName}</span>
          <span className="font-medium shrink-0 text-success">A</span>
          <span className="text-success shrink-0">
            +{computeFileStats(diffFile.hunks).insertions}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
        {note ? (
          <div className="px-3 py-6 text-xs text-center text-muted-foreground">{note}</div>
        ) : tooLarge ? (
          <LoadDiffPrompt
            lines={diffLineCount(diffFile!.hunks)}
            onLoad={() => setRequested(true)}
          />
        ) : (
          <DiffViewer
            diffFile={diffFile}
            loading={isLoading}
            diffViewMode={DiffModeEnum.Unified}
            reviewMode={reviewMode}
            comments={comments}
            activeCommentLine={activeCommentLine}
            onAddComment={onAddComment}
            onRemoveComment={onRemoveComment}
            onEditComment={onEditComment}
            onCancelComment={onCancelComment}
            onSubmitComment={onSubmitComment}
            onSendComment={onSendComment}
            commentNav={commentNav}
            sendDisabled={sendDisabled}
            highlight={highlight}
          />
        )}
      </div>
    </div>
  );
}
