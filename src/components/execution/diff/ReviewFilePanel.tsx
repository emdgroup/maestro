import { useEffect, useMemo } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { FileTree } from "./FileTree";

export interface ReviewFilePanelProps {
  files: Array<{ fileName: string; status?: "A" | "M" | "D" }>;
  selectedFile: string | null;
  onSelectFile: (fileName: string) => void;
  viewedFiles?: Set<string>;
  /** Controlled, so a host can clear it to reveal a file the filter is hiding. */
  search: string;
  onSearchChange: (value: string) => void;
  className?: string;
}

/**
 * The review's file list: a filter above a tree.
 *
 * Identical in task review and the session Changes tab — the scope selector that used to differ
 * between them now lives in each host's action bar instead, which is what leaves nothing here to
 * vary. Tree only: a review is read by where files sit in the project, and the flat/tree toggle
 * was one more control for a choice nobody re-made.
 *
 * It renders `FileTree` directly rather than going through `FileSelector`, whose remaining job is
 * the flat mode and its toggle. That also lets the filter be a control sitting on the panel rather
 * than a full-width bordered row, which read as a second header stacked under the real one.
 */
export function ReviewFilePanel({
  files,
  selectedFile,
  onSelectFile,
  viewedFiles,
  search,
  onSearchChange,
  className,
}: ReviewFilePanelProps) {
  const query = search.trim().toLowerCase();
  const treeFiles = useMemo(
    () =>
      files
        .filter((file) => !query || file.fileName.toLowerCase().includes(query))
        .map((file) => ({ fileName: file.fileName, hunks: [] as [], status: file.status })),
    [files, query],
  );

  return (
    <div className={cn("flex flex-col min-h-0 bg-card", className)}>
      <div className="px-2 py-2 shrink-0">
        <div className="flex items-center gap-1.5 h-7 px-2 rounded-md border border-border bg-background focus-within:border-ring transition-colors">
          <Search className="size-3 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter files..."
            className="flex-1 min-w-0 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          {search && (
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => onSearchChange("")}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-3" />
              </TooltipTrigger>
              <TooltipContent>Clear filter</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <FileTree
          files={treeFiles}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          viewedFiles={viewedFiles}
        />
      </div>
    </div>
  );
}

/**
 * The same panel floating over the diff, for a container too narrow to seat it alongside.
 *
 * It covers the container rather than sitting in a rail, so there is no "outside" left to click:
 * picking a file dismisses it, as does the host's toggle.
 *
 * Escape does too, but only where the review is not inside a dialog — base-ui consumes the key
 * before a `window` listener can see it, so in task review and the worktree view the dialog is
 * what Escape reaches. That is why it is not the only way out.
 */
export function ReviewFilePanelOverlay({
  onDismiss,
  onSelectFile,
  ...props
}: ReviewFilePanelProps & { onDismiss: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <ReviewFilePanel
      {...props}
      onSelectFile={(fileName) => {
        onSelectFile(fileName);
        onDismiss();
      }}
      className="absolute inset-0 z-30 border-r border-border"
    />
  );
}
