import { useState, useEffect, useRef, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard,
  Bot,
  SquarePlay,
  FileDiff,
  ScrollText,
  Paperclip,
  FileText,
  Terminal,
  ChevronRight,
  ChevronLeft,
  X,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { ReviewChangesPanel } from "@/components/execution/activity/ReviewChangesPanel";
import { CanvasRenderer } from "@/components/execution/activity/canvas/CanvasRenderer";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { OverviewPanel } from "./OverviewPanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import type { CanvasSurface, ToolCallItem } from "@/components/execution/activity/types";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";
import type { ConnectionKey } from "@/types/bindings";

// Re-export so AgentActivityPanel can still import SidePanelTab from this file
export type { SidePanelTab, TabKind } from "./useSidePanelTabs";

const KIND_ICON: Record<TabKind, React.ElementType> = {
  overview: LayoutDashboard,
  plan: ScrollText,
  subagents: Bot,
  canvas: SquarePlay,
  review: FileDiff,
  artifacts: Paperclip,
  files: FileText,
  terminal: Terminal,
};

interface ExecutionSidePanelProps {
  sessionKey: number;
  tabs: SidePanelTab[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  onTabClose: (id: string) => void;
  onAddTab: (kind: "terminal" | "files") => string;
  onOpenTabKind: (kind: TabKind) => void;
  workingFiles: string[];
  changedFiles: string[];
  projectPath: string;
  connection: ConnectionKey;
  canvasMap: Map<string, CanvasSurface>;
  latestCanvasSurfaceId: string | null;
  subagentItems: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
  sidePanelPlan: { body: string; title: string | null; requestId: string } | null;
  onPlanRespond: (accept: boolean) => void;
  collapsed: boolean;
  onCollapsedChange: (c: boolean) => void;
  fill?: boolean;
  onSpawnShell?: () => Promise<number | null>;
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
  changedFiles,
  projectPath,
  connection,
  canvasMap,
  latestCanvasSurfaceId,
  subagentItems,
  toolCallMap,
  sidePanelPlan,
  onPlanRespond,
  collapsed,
  onCollapsedChange,
  fill = false,
  onSpawnShell,
}: ExecutionSidePanelProps) {
  // PTY state per terminal tab
  const [ptyState, setPtyState] = useState<Map<string, { key: number | null; failed: boolean }>>(
    new Map(),
  );
  const spawningRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!onSpawnShell) return;
    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      if (ptyState.has(tab.id)) continue;
      if (spawningRef.current.has(tab.id)) continue;
      const tabId = tab.id;
      spawningRef.current.add(tabId);
      onSpawnShell()
        .then((key) =>
          setPtyState((prev) => new Map(prev).set(tabId, { key, failed: key === null })),
        )
        .catch(() => setPtyState((prev) => new Map(prev).set(tabId, { key: null, failed: true })))
        .finally(() => spawningRef.current.delete(tabId));
    }
  }, [tabs, ptyState, onSpawnShell]);

  // Canvas carousel
  const canvasEntries = useMemo(() => [...canvasMap.entries()], [canvasMap]);
  const [canvasIdx, setCanvasIdx] = useState(0);

  useEffect(() => {
    if (!latestCanvasSurfaceId) return;
    const idx = canvasEntries.findIndex(([id]) => id === latestCanvasSurfaceId);
    if (idx >= 0) setCanvasIdx(idx);
  }, [latestCanvasSurfaceId, canvasEntries]);

  const activeSurface = canvasEntries[canvasIdx]?.[1] ?? null;

  const addTabPopoverContent = (side: "bottom" | "left") => (
    <PopoverContent align="start" side={side} className="w-44 p-1 gap-0">
      <button
        type="button"
        onClick={() => {
          onAddTab("terminal");
          onCollapsedChange(false);
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded hover:bg-muted/60 text-left transition-colors"
      >
        <Terminal className="w-3.5 h-3.5 text-muted-foreground" />
        New Terminal
      </button>
      <button
        type="button"
        onClick={() => {
          onAddTab("files");
          onCollapsedChange(false);
        }}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs rounded hover:bg-muted/60 text-left transition-colors"
      >
        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
        Files Browser
      </button>
    </PopoverContent>
  );

  return (
    <div
      className={cn(
        "flex flex-col border-l border-border bg-card/40 overflow-hidden",
        fill
          ? "h-full w-full"
          : collapsed
            ? "w-11 flex-none shrink-0 transition-[width,flex] duration-200"
            : "flex-1 max-w-[50%] min-w-56 shrink-0 transition-[width,flex] duration-200",
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {collapsed ? (
          /* Collapsed: vertical icon strip */
          <motion.div
            key="collapsed"
            className="flex flex-col items-center py-2 gap-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <button
              type="button"
              onClick={() => onCollapsedChange(false)}
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              title="Expand panel"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="w-5 h-px bg-border my-1" />
            {tabs.map(({ id, kind, label }) => {
              const Icon = KIND_ICON[kind];
              return (
                <button
                  key={id}
                  type="button"
                  title={label}
                  onClick={() => {
                    onTabChange(id);
                    onCollapsedChange(false);
                  }}
                  className={cn(
                    "p-2 rounded-md transition-colors",
                    activeTabId === id
                      ? "text-foreground bg-muted/60"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                >
                  <Icon className="w-4 h-4" />
                </button>
              );
            })}
            <div className="w-5 h-px bg-border my-1" />
            <Popover>
              <PopoverTrigger
                className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                title="Add tab"
              >
                <Plus className="w-4 h-4" />
              </PopoverTrigger>
              {addTabPopoverContent("left")}
            </Popover>
          </motion.div>
        ) : (
          /* Expanded: tab bar + content */
          <motion.div
            key="expanded"
            className="flex flex-col h-full min-h-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {/* Tab bar */}
            <div className="flex items-center border-b border-border shrink-0 bg-card/50">
              <button
                type="button"
                onClick={() => onCollapsedChange(true)}
                className="p-2.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                title="Collapse panel"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="flex items-center flex-1 overflow-x-auto scrollbar-none min-w-0">
                {tabs.map(({ id, kind, label, closeable }) => {
                  const Icon = KIND_ICON[kind];
                  const isActive = activeTabId === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => onTabChange(id)}
                      className={cn(
                        "group flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium whitespace-nowrap transition-colors border-b-2",
                        isActive
                          ? "text-foreground border-primary"
                          : "text-muted-foreground border-transparent hover:text-foreground",
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                      {closeable && (
                        <span
                          role="button"
                          tabIndex={-1}
                          onKeyDown={(e) => e.key === "Enter" && onTabClose(id)}
                          onClick={(e) => {
                            e.stopPropagation();
                            onTabClose(id);
                          }}
                          className={cn(
                            "ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-muted transition-colors",
                            isActive
                              ? "opacity-70 hover:opacity-100"
                              : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
                          )}
                        >
                          <X className="w-2.5 h-2.5" />
                        </span>
                      )}
                    </button>
                  );
                })}
                <Popover>
                  <PopoverTrigger
                    className="p-2 mx-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                    title="Add tab"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </PopoverTrigger>
                  {addTabPopoverContent("bottom")}
                </Popover>
              </div>
            </div>

            {/* Content: all panels mounted, inactive ones hidden */}
            <div className="flex-1 relative min-h-0">
              {tabs.map(({ id, kind }) => {
                const isActive = activeTabId === id;
                const ptyEntry = kind === "terminal" ? ptyState.get(id) : undefined;
                return (
                  <div key={id} className={cn("absolute inset-0", !isActive && "hidden")}>
                    {kind === "overview" && (
                      <OverviewPanel
                        subagentItems={subagentItems}
                        canvasCount={canvasMap.size}
                        changedFilesCount={changedFiles.length}
                        hasPlan={!!sidePanelPlan}
                        artifactFilesCount={workingFiles.length}
                        onNavigate={onOpenTabKind}
                      />
                    )}
                    {kind === "plan" && (
                      <div className="absolute inset-0 flex flex-col overflow-hidden">
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                          {sidePanelPlan?.title && (
                            <h3 className="text-sm font-semibold mb-3 text-foreground">
                              {sidePanelPlan.title}
                            </h3>
                          )}
                          {sidePanelPlan?.body ? (
                            <MarkdownBlock text={sidePanelPlan.body} />
                          ) : (
                            <p className="text-xs text-muted-foreground">No plan yet</p>
                          )}
                        </div>
                        {!!sidePanelPlan && (
                          <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-border bg-card/50">
                            <button
                              type="button"
                              onClick={() => onPlanRespond(false)}
                              className="flex-1 py-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              onClick={() => onPlanRespond(true)}
                              className="flex-1 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                            >
                              Accept
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {kind === "subagents" && (
                      <SubagentsPanel items={subagentItems} toolCallMap={toolCallMap} />
                    )}
                    {kind === "canvas" && (
                      <div className="absolute inset-0 flex flex-col overflow-hidden">
                        {canvasEntries.length > 1 && (
                          <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-border">
                            <span className="text-xs text-muted-foreground">
                              {canvasIdx + 1} / {canvasEntries.length}
                            </span>
                            <div className="flex gap-1">
                              <button
                                type="button"
                                disabled={canvasIdx === 0}
                                onClick={() => setCanvasIdx((i) => Math.max(0, i - 1))}
                                className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                              >
                                <ChevronLeft className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                disabled={canvasIdx >= canvasEntries.length - 1}
                                onClick={() =>
                                  setCanvasIdx((i) => Math.min(canvasEntries.length - 1, i + 1))
                                }
                                className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                              >
                                <ChevronRight className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
                          {activeSurface && activeSurface.components.length > 0 ? (
                            <CanvasRenderer surface={activeSurface} />
                          ) : (
                            <p className="text-xs text-muted-foreground">No canvas active</p>
                          )}
                        </div>
                      </div>
                    )}
                    {kind === "review" && (
                      <ReviewChangesPanel
                        sessionKey={sessionKey}
                        sessionChangedFiles={changedFiles}
                        onClose={() => onCollapsedChange(true)}
                        compact
                      />
                    )}
                    {kind === "artifacts" && (
                      <ArtifactsPanel files={workingFiles} sessionKey={sessionKey} />
                    )}
                    {kind === "files" && (
                      <WorkspaceFilesPanel projectPath={projectPath} connection={connection} />
                    )}
                    {kind === "terminal" && (
                      <div className="absolute inset-0">
                        {ptyEntry?.key != null ? (
                          <TerminalComponent taskId={ptyEntry.key} />
                        ) : ptyEntry?.failed ? (
                          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                            Failed to start terminal
                          </div>
                        ) : (
                          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                            Starting terminal…
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
