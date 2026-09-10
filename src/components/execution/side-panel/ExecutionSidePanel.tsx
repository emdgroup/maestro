import { useCallback, useState } from "react";
import { Terminal, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { PopoverContent, PopoverClose } from "@/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { SidePanelCollapsedStrip } from "./SidePanelCollapsedStrip";
import { SidePanelTabBar } from "./SidePanelTabBar";
import { SidePanelContent } from "./SidePanelContent";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";
import type { CanvasSurface, PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import type { ConnectionKey } from "@/types/bindings";
import type { Annotation } from "@/store/annotationStore";

// Re-export so AgentActivityPanel can still import SidePanelTab from this file
export type { SidePanelTab, TabKind } from "./useSidePanelTabs";

interface ExecutionSidePanelProps {
  sessionKey: number;
  tabs: SidePanelTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  onTabClose: (id: string) => void;
  onAddTab: (kind: "terminal" | "files", initialPath?: string) => string;
  onOpenTabKind: (kind: TabKind) => void;
  /** Opens a path (absolute, or project-relative) in a Files tab. */
  onOpenFile: (path: string) => void;
  workingFiles: WorkingFileEntry[];
  taskId: number | null;
  workspacePath: string;
  connection: ConnectionKey;
  canvasMap: Map<string, CanvasSurface>;
  latestCanvasSurfaceId: string | null;
  subagentItems: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
  sidePanelPlan: { requestId: string; payload: Record<string, unknown> } | null;
  planEntries?: PlanEntry[] | null;
  planTitle?: string | null;
  collapsed: boolean;
  onCollapsedChange: (c: boolean) => void;
  unseenTabIds: ReadonlySet<string>;
  maximized?: boolean;
  onMaximizedChange?: (v: boolean) => void;
  fill?: boolean;
  isSessionActive?: boolean;
  onSpawnShell?: () => Promise<number | null>;
  terminalBuffers?: Map<string, string>;
  onSendAnnotations: (annotations: Annotation[]) => void;
  isProcessing?: boolean;
  canSendImages?: boolean;
  onSeedPrompt?: (text: string) => void;
}

export function ExecutionSidePanel({
  sessionKey,
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onAddTab,
  onOpenTabKind,
  onOpenFile,
  workingFiles,
  taskId,
  workspacePath,
  connection,
  canvasMap,
  latestCanvasSurfaceId,
  subagentItems,
  toolCallMap,
  sidePanelPlan,
  planEntries,
  planTitle,
  collapsed,
  onCollapsedChange,
  unseenTabIds,
  maximized = false,
  onMaximizedChange,
  fill = false,
  isSessionActive = true,
  onSpawnShell,
  terminalBuffers,
  onSendAnnotations,
  isProcessing,
  canSendImages,
  onSeedPrompt,
}: ExecutionSidePanelProps) {
  // Closing a Files tab unmounts its editor and takes the draft with it, and the tab bar's X is
  // several components away from the panel that knows about the draft — hence the registry here
  // rather than a check inside `useSidePanelTabs`, which owns no content.
  const [dirtyTabIds, setDirtyTabIds] = useState<ReadonlySet<string>>(() => new Set());
  const [closePrompt, setClosePrompt] = useState<string | null>(null);

  const forgetTab = useCallback((id: string) => {
    setDirtyTabIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleTabDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyTabIds((prev) => {
      if (prev.has(id) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const requestTabClose = useCallback(
    (id: string) => {
      if (dirtyTabIds.has(id)) setClosePrompt(id);
      else onTabClose(id);
    },
    [dirtyTabIds, onTabClose],
  );

  const addTabPopoverContent = (side: "bottom" | "left") => (
    <PopoverContent align="start" side={side} className="w-44 p-1 gap-0">
      <PopoverClose
        onClick={() => {
          onAddTab("terminal");
          onCollapsedChange(false);
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded hover:bg-muted/60 text-left transition-colors"
      >
        <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
        New Terminal
      </PopoverClose>
      <PopoverClose
        onClick={() => {
          onAddTab("files");
          onCollapsedChange(false);
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded hover:bg-muted/60 text-left transition-colors"
      >
        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        Files Browser
      </PopoverClose>
    </PopoverContent>
  );

  return (
    <div
      className={cn(
        "flex flex-col bg-card overflow-hidden",
        fill
          ? "h-full w-full"
          : collapsed
            ? "w-11 flex-none shrink-0 transition-[width,flex] duration-200"
            : "flex-1 max-w-[50%] min-w-56 shrink-0 transition-[width,flex] duration-200",
      )}
    >
      {collapsed ? (
        <SidePanelCollapsedStrip
          tabs={tabs}
          activeTabId={activeTabId}
          onTabChange={onTabChange}
          onCollapsedChange={onCollapsedChange}
          onMaximizedChange={onMaximizedChange}
          addTabContent={addTabPopoverContent}
          unseenTabIds={unseenTabIds}
        />
      ) : (
        <div className="flex flex-col h-full min-h-0">
          <SidePanelTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={onTabChange}
            onTabClose={requestTabClose}
            onCollapsedChange={onCollapsedChange}
            onMaximizedChange={onMaximizedChange}
            maximized={maximized}
            addTabContent={addTabPopoverContent}
          />
          <div className="flex-1 min-h-0 flex flex-col pl-[10px]">
            <div className="flex-1 relative min-h-0 rounded-tl-xl border-t border-l border-border bg-background overflow-hidden">
              <SidePanelContent
                tabs={tabs}
                activeTabId={activeTabId}
                isSessionActive={isSessionActive}
                sessionKey={sessionKey}
                subagentItems={subagentItems}
                toolCallMap={toolCallMap}
                sidePanelPlan={sidePanelPlan}
                canvasMap={canvasMap}
                latestCanvasSurfaceId={latestCanvasSurfaceId}
                workingFiles={workingFiles}
                taskId={taskId}
                workspacePath={workspacePath}
                connection={connection}
                planEntries={planEntries}
                planTitle={planTitle}
                onCollapsedChange={onCollapsedChange}
                onOpenTabKind={onOpenTabKind}
                onOpenFile={onOpenFile}
                onSpawnShell={onSpawnShell}
                terminalBuffers={terminalBuffers}
                onSendAnnotations={onSendAnnotations}
                isProcessing={isProcessing}
                canSendImages={canSendImages}
                onSeedPrompt={onSeedPrompt}
                onTabDirtyChange={handleTabDirtyChange}
              />
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={closePrompt !== null}
        onOpenChange={(open) => {
          if (!open) setClosePrompt(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this tab and discard your edits?</AlertDialogTitle>
            <AlertDialogDescription>
              This Files tab has changes that have not been written to disk. Closing it loses them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (closePrompt !== null) {
                  forgetTab(closePrompt);
                  onTabClose(closePrompt);
                }
                setClosePrompt(null);
              }}
            >
              Discard and close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
