import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/ui/resizable";
import {
  ReviewFilePanel,
  ReviewFilePanelOverlay,
  ReviewPanelOverlayShell,
  type ReviewFilePanelProps,
} from "./ReviewFilePanel";
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  type ReviewPanelState,
} from "./useReviewPanelLayout";

/** Opens and closes the file panel. Its meaning is the same in either layout; only what "open" looks like changes. */
export function FilePanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const label = open ? "Hide file list" : "Show file list";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={label}
            className="size-8 p-0"
            onClick={onToggle}
          />
        }
      >
        <PanelLeft className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface ReviewLayoutProps {
  panel: ReviewPanelState;
  /** Everything the review's file list needs. The layout decides where it is drawn, not what it shows. */
  files?: ReviewFilePanelProps;
  /**
   * A panel that is not the review's file list — the Files tab's lazy directory tree. `onDismiss`
   * is given only in the overlay layout, where picking something has to close the panel too; in the
   * inline layout the panel is a column that stays.
   */
  renderPanel?: (options: { onDismiss?: () => void }) => React.ReactNode;
  /** The card stack. Seated on the inset surface when the panel is beside it. */
  children: React.ReactNode;
}

/**
 * A review's two halves: the file list and the diff.
 *
 * All three hosts — task review, the session Changes tab, the worktree view — put the same two
 * things on screen in the same two arrangements, and the differences between them are all above
 * this component, in their own action bars. Keeping the arrangement here is what stops the three
 * from drifting into three slightly different answers to "where does the sidebar go".
 *
 * Wide enough, and the panel is a resizable column and the diff sits inset beside it, rounded at
 * the corner where the two meet. Too narrow, and the panel floats over the diff instead.
 *
 * The Files tab is the fourth host and the one that is not a review: its panel is a lazy directory
 * tree rather than a list of changed files, which is what `renderPanel` is for. Everything else —
 * which arrangement, how wide, how the overlay is dismissed — it shares with the other three.
 */
export function ReviewLayout({ panel, files, renderPanel, children }: ReviewLayoutProps) {
  const {
    containerRef,
    inset,
    panelOpen,
    setPanelOpen,
    sidebarWidth,
    trackSidebarWidth,
    commitSidebarWidth,
  } = panel;

  const diffSurface = (
    <div className={cn("flex flex-col flex-1 min-h-0", inset && "pt-2")}>
      <div
        className={cn(
          "flex flex-col flex-1 min-h-0 border-t border-border bg-background overflow-hidden",
          inset && "rounded-tl-xl border-l",
        )}
      >
        {children}
      </div>
    </div>
  );

  return (
    <div ref={containerRef} className="relative flex flex-1 min-h-0 bg-card">
      {inset ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 min-h-0"
          // Only once the pointer is released. Adopting the width on every drag frame would change
          // `defaultSize` mid-drag, and the panel re-registers when that happens.
          onLayoutChanged={(_layout, meta) => {
            if (meta.isUserInteraction) commitSidebarWidth();
          }}
        >
          <ResizablePanel
            defaultSize={sidebarWidth}
            minSize={SIDEBAR_MIN_WIDTH}
            maxSize={SIDEBAR_MAX_WIDTH}
            onResize={(size) => trackSidebarWidth(size.inPixels)}
            className="flex flex-col min-h-0"
          >
            {renderPanel ? renderPanel({}) : files && <ReviewFilePanel {...files} />}
          </ResizablePanel>
          {/* No bar of its own: the diff surface's left border is already the line between the
              two, and the handle runs the full height, so a hover tint on it painted a stripe past
              the rounded corner. The grip lights up instead. */}
          <ResizableHandle
            withHandle
            className="bg-transparent hover:bg-transparent hover:[&>div]:bg-accent"
          />
          <ResizablePanel className="flex flex-col min-w-0 min-h-0">{diffSurface}</ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          <div className="flex-1 flex flex-col min-w-0">{diffSurface}</div>
          {panelOpen &&
            (renderPanel ? (
              <ReviewPanelOverlayShell onDismiss={() => setPanelOpen(false)}>
                {renderPanel({ onDismiss: () => setPanelOpen(false) })}
              </ReviewPanelOverlayShell>
            ) : (
              files && <ReviewFilePanelOverlay {...files} onDismiss={() => setPanelOpen(false)} />
            ))}
        </>
      )}
    </div>
  );
}
