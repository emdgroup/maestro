import { DiffModeEnum } from "@git-diff-view/react";
import { X, AlignJustify, Columns2, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Button } from "@/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";

interface DiffActionBarProps {
  mode?: "worktree" | "review" | "session";
  branchName?: string;
  /** Sits at the far left — the file-panel toggle and the scope selector. */
  leadingSlot?: React.ReactNode;
  diffViewMode: DiffModeEnum;
  onDiffViewModeChange: (mode: DiffModeEnum) => void;
  onClose: () => void;
  viewedCount?: number;
  totalFileCount?: number;
  splitButtonNode?: React.ReactNode;
  centerLabel?: string;
  /** Chrome, for a host that seats the bar on the same surface as its file panel. */
  className?: string;
}

export function DiffActionBar({
  mode = "worktree",
  branchName,
  leadingSlot,
  diffViewMode,
  onDiffViewModeChange,
  onClose,
  viewedCount,
  totalFileCount,
  splitButtonNode,
  centerLabel,
  className,
}: DiffActionBarProps) {
  const splitActive = diffViewMode === DiffModeEnum.SplitGitHub;

  return (
    <div
      className={cn(
        "relative h-12 border-b border-border bg-muted/30 flex items-center px-4 shrink-0",
        className,
      )}
    >
      {/* Left side: the host's own controls */}
      <div className="flex items-center gap-2 z-10">{leadingSlot}</div>

      {/* Center section */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {mode === "worktree" && branchName && (
          <span className="font-mono text-sm font-semibold truncate max-w-48">{branchName}</span>
        )}
        {mode === "review" && centerLabel && (
          <span className="font-mono text-sm font-semibold truncate max-w-48 text-accent">
            {centerLabel}
          </span>
        )}
        {mode === "session" && centerLabel && (
          <span className="font-mono text-sm font-semibold truncate max-w-48">{centerLabel}</span>
        )}
      </div>

      {/* Right side: viewed counter + unified/split toggle + split button node + close button */}
      <div className="ml-auto flex items-center gap-2 z-10">
        {viewedCount != null && viewedCount > 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <CheckCheck className="size-3.5" />
            <span>
              {viewedCount}/{totalFileCount} viewed
            </span>
          </div>
        )}
        <ToggleGroup
          value={[splitActive ? "split" : "unified"]}
          onValueChange={(values) => {
            if (values.includes("split")) {
              onDiffViewModeChange(DiffModeEnum.SplitGitHub);
            } else {
              onDiffViewModeChange(DiffModeEnum.Unified);
            }
          }}
        >
          <ToggleGroupItem value="unified" size="sm" variant="outline" className="size-8 p-0">
            <AlignJustify className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="split" size="sm" variant="outline" className="size-8 p-0">
            <Columns2 className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === "review" && splitButtonNode}
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
