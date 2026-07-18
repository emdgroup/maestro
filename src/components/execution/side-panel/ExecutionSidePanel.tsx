import { Terminal, FileText } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { PopoverContent, PopoverClose } from "@/ui/popover";
import { SidePanelCollapsedStrip } from "./SidePanelCollapsedStrip";
import { SidePanelTabBar } from "./SidePanelTabBar";
import { SidePanelContent } from "./SidePanelContent";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";
import type { CanvasSurface, PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import type { ConnectionKey } from "@/types/bindings";

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
  workingFiles: WorkingFileEntry[];
  taskId: number | null;
  changedFiles: string[];
  projectPath: string;
  connection: ConnectionKey;
  canvasMap: Map<string, CanvasSurface>;
  latestCanvasSurfaceId: string | null;
  subagentItems: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
  sidePanelPlan: { requestId: string; payload: Record<string, unknown> } | null;
  planEntries?: PlanEntry[] | null;
  planTitle?: string | null;
  onPlanRespond: (requestId: string, optionId: string | null) => void;
  collapsed: boolean;
  onCollapsedChange: (c: boolean) => void;
  maximized?: boolean;
  onMaximizedChange?: (v: boolean) => void;
  fill?: boolean;
  isSessionActive?: boolean;
  onSpawnShell?: () => Promise<number | null>;
  terminalBuffers?: Map<string, string>;
}

export function ExecutionSidePanel({
  sessionKey,
  tabs,
  activeTabId,
  onTabChange,
  onTabClose,
  onAddTab,
  onOpenTabKind,
  workingFiles,
  taskId,
  changedFiles,
  projectPath,
  connection,
  canvasMap,
  latestCanvasSurfaceId,
  subagentItems,
  toolCallMap,
  sidePanelPlan,
  planEntries,
  planTitle,
  onPlanRespond,
  collapsed,
  onCollapsedChange,
  maximized = false,
  onMaximizedChange,
  fill = false,
  isSessionActive = true,
  onSpawnShell,
  terminalBuffers,
}: ExecutionSidePanelProps) {
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
        />
      ) : (
        <div className="flex flex-col h-full min-h-0">
          <SidePanelTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={onTabChange}
            onTabClose={onTabClose}
            onCollapsedChange={onCollapsedChange}
            onMaximizedChange={onMaximizedChange}
            maximized={maximized}
            addTabContent={addTabPopoverContent}
          />
          <div className="flex-1 relative min-h-0">
            <SidePanelContent
              tabs={tabs}
              activeTabId={activeTabId}
              isSessionActive={isSessionActive}
              sessionKey={sessionKey}
              subagentItems={subagentItems}
              toolCallMap={toolCallMap}
              sidePanelPlan={sidePanelPlan}
              onPlanRespond={onPlanRespond}
              canvasMap={canvasMap}
              latestCanvasSurfaceId={latestCanvasSurfaceId}
              changedFiles={changedFiles}
              workingFiles={workingFiles}
              taskId={taskId}
              projectPath={projectPath}
              connection={connection}
              planEntries={planEntries}
              planTitle={planTitle}
              onCollapsedChange={onCollapsedChange}
              onOpenTabKind={onOpenTabKind}
              onSpawnShell={onSpawnShell}
              terminalBuffers={terminalBuffers}
            />
          </div>
        </div>
      )}
    </div>
  );
}
