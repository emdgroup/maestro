import { Check, CheckCheck, ChevronRight, Copy, MessageSquare } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils.ts";
import { computeFileStats } from "@/lib/diff-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useCopyToClipboard } from "@/components/execution/activity/HighlightedCode";
import { ReviewFileComment, type FileCommentApi } from "./ReviewFileComment";
import type { DiffFileWithName } from "@/types/review";

/**
 * What to show instead of a diff for a change git describes without hunks — a rename, a binary
 * file, a mode change. Exported so neither host writes the fallback string itself.
 */
export function fileNote(file: DiffFileWithName): string | undefined {
  return file.hunks.length === 0
    ? (file.note ?? "There is no line-by-line diff to show for this file.")
    : undefined;
}

// Its own component because the cards render in a loop and the copy hook holds the "copied"
// flag per path.
function CopyPathButton({ path }: { path: string }) {
  const { copied, copy } = useCopyToClipboard(path);
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label="Copy path"
        onClick={(e) => {
          e.stopPropagation();
          copy();
        }}
        className="p-1 rounded transition-colors shrink-0 text-muted-foreground/70 hover:text-foreground hover:bg-muted/30"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy path"}</TooltipContent>
    </Tooltip>
  );
}

function DiffStats({ hunks }: { hunks: string[] }) {
  const s = computeFileStats(hunks);
  return (
    <span className="flex items-center gap-1 shrink-0 text-xs font-mono">
      {s.insertions > 0 && <span className="text-success">+{s.insertions}</span>}
      {s.deletions > 0 && <span className="text-destructive">-{s.deletions}</span>}
    </span>
  );
}

interface ReviewFileCardProps {
  /** Repo-relative path — the card's identity, its label, and what Copy path yields. */
  path: string;
  /** Raw hunks; the card derives +/- itself. Empty for an untracked file. */
  hunks: string[];
  viewed: boolean;
  onToggleViewed: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** The card the host considers current. Omitted ⇒ hover tint only. */
  focused?: boolean;
  /**
   * The reader picked this card. Called for a press anywhere on it — the header, or a line in the
   * diff — since reading a file is picking it. Omitted ⇒ the card cannot be selected by clicking.
   */
  onSelect?: () => void;
  /** Open this file elsewhere. Omitted ⇒ the name is plain text rather than a link button. */
  onOpenFile?: () => void;
  /** Shown in place of `children`. See `fileNote`. */
  note?: string;
  /** Omitted ⇒ the card carries no comment affordance at all. The worktree view reads a diff
   *  without anyone to send remarks to, so there is nothing for the button to mean there. */
  fileComment?: FileCommentApi;
  /** The diff body — a `DiffViewer` or an `UntrackedFileDiffViewer`. */
  children: React.ReactNode;
  /** The card's outer box. A stack reads its `offsetTop` to tell which file is on screen. */
  ref?: React.Ref<HTMLDivElement>;
}

/**
 * One file in a review: a header that collapses it, and the diff beneath.
 *
 * Shared by the session panel's Changes tab and task review, which is the point — the same file
 * read in either place should look and behave the same. Everything specific to a host is either a
 * prop it omits (`onOpenFile`) or lives outside the card entirely.
 */
export function ReviewFileCard({
  path,
  hunks,
  viewed,
  onToggleViewed,
  expanded,
  onToggleExpanded,
  focused,
  onSelect,
  onOpenFile,
  note,
  fileComment,
  children,
  ref,
}: ReviewFileCardProps) {
  const [editingComment, setEditingComment] = useState(false);
  const hasComment = fileComment?.comment != null;

  function openFileComment(e: React.MouseEvent) {
    e.stopPropagation();
    // A note on a collapsed card is invisible, so opening one opens the card with it.
    if (!expanded) onToggleExpanded();
    setEditingComment(true);
  }

  // `data-file-card` marks the element `DiffFileStack` measures for its scroll spy.
  //
  // `onSelect` sits on the outer box rather than on the header so that a click in the diff counts
  // too. The header controls all stop the event, which keeps them from moving the selection — being
  // told a file is viewed is not the same as being told to look at it.
  return (
    <div ref={ref} data-file-card={path} className="shrink-0" onClick={onSelect}>
      <div className="sticky top-0 z-10 pt-3 bg-background">
        <div
          onClick={onToggleExpanded}
          className={cn(
            "border bg-card flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors",
            expanded ? "rounded-t-lg" : "rounded-lg",
            // The card outlined in the accent, rather than a tint on the header. The tint was
            // competing with the hover state on the same element and lost — this reads at a
            // glance, and from the body as well as the header.
            focused ? "border-accent" : "border-border hover:bg-muted/20",
            // Except where the header meets the body, which is a divider inside the card rather
            // than part of its outline: in the accent it draws a line straight across the middle.
            focused && expanded && "border-b-border",
          )}
        >
          <ChevronRight
            className={cn(
              "w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          {onOpenFile ? (
            // The wrapper takes the free space so the stats stay right-aligned; the button itself
            // only spans the file name, so clicking the empty rest of the row still toggles.
            <div className="flex-1 min-w-0 flex">
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenFile();
                  }}
                  className="text-xs font-mono truncate max-w-full text-foreground/80 text-left hover:underline underline-offset-2 hover:text-foreground transition-colors"
                >
                  {path}
                </TooltipTrigger>
                <TooltipContent>Open in a Files tab</TooltipContent>
              </Tooltip>
            </div>
          ) : (
            <span className="text-xs font-mono truncate text-foreground/80 flex-1">{path}</span>
          )}
          <DiffStats hunks={hunks} />
          <CopyPathButton path={path} />
          {fileComment && (
            <Tooltip>
              <TooltipTrigger
                type="button"
                aria-label={hasComment ? "Edit file comment" : "Add file comment"}
                onClick={openFileComment}
                className={cn(
                  "p-1 rounded transition-colors shrink-0 hover:bg-muted/30",
                  // An existing note is the only sign of itself while the card is shut.
                  hasComment ? "text-accent" : "text-muted-foreground/70 hover:text-foreground",
                )}
              >
                <MessageSquare className="size-3" />
              </TooltipTrigger>
              <TooltipContent>
                {hasComment ? "Edit file comment" : "Add file comment"}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label={viewed ? "Mark as unviewed" : "Mark as viewed"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleViewed();
              }}
              className={cn(
                "p-1 rounded transition-colors shrink-0",
                viewed
                  ? "text-success hover:bg-muted/30"
                  : "text-muted-foreground/70 hover:text-foreground hover:bg-muted/30",
              )}
            >
              <CheckCheck className="size-3" />
            </TooltipTrigger>
            <TooltipContent>{viewed ? "Mark as unviewed" : "Mark as viewed"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      {expanded && (
        <div
          className={cn(
            "border border-t-0 rounded-b-lg overflow-auto custom-scrollbar transition-colors",
            focused ? "border-accent" : "border-border",
          )}
        >
          {fileComment && (
            <ReviewFileComment
              fileComment={fileComment}
              editing={editingComment}
              onEditingChange={setEditingComment}
            />
          )}
          {note ? (
            <div className="px-3 py-6 text-xs text-center text-muted-foreground">{note}</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}
