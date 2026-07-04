import { useState, useEffect, useRef, useMemo } from "react";
import { motion } from "framer-motion";
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
  Maximize2,
  Minimize2,
} from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { ReviewChangesPanel } from "@/components/execution/activity/ReviewChangesPanel";
import { CanvasRenderer } from "@/components/execution/activity/canvas/CanvasRenderer";
import { PermissionPrompt } from "@/components/execution/activity/PermissionPrompt";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { OverviewPanel } from "./OverviewPanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import type { CanvasSurface, PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";
import type { ConnectionKey, DiffTarget } from "@/types/bindings";
import { useWorktreeDiffQuery } from "@/services/worktree.service";
import { useWslConnections } from "@/services/connection.service";
import { parseDiffString, computeFileStats } from "@/lib/diff-utils";
import { api } from "@/lib/tauri-utils";

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
  onPlanRespond: (requestId: string, optionId: string | null) => void;
  collapsed: boolean;
  onCollapsedChange: (c: boolean) => void;
  maximized?: boolean;
  onMaximizedChange?: (v: boolean) => void;
  fill?: boolean;
  isSessionActive?: boolean;
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
  onPlanRespond,
  collapsed,
  onCollapsedChange,
  maximized = false,
  onMaximizedChange,
  fill = false,
  isSessionActive = true,
  onSpawnShell,
}: ExecutionSidePanelProps) {
  const [sessionMeta, setSessionMeta] = useState<{
    projectId: number | null;
    cwd: string | null;
    startSha: string | null;
  }>({ projectId: null, cwd: null, startSha: null });

  useEffect(() => {
    api
      .getAcpSessionMeta(sessionKey)
      .then((meta) => {
        setSessionMeta({
          projectId: meta.project_id,
          cwd: meta.cwd,
          startSha: meta.session_start_sha,
        });
      })
      .catch(() => {});
  }, [sessionKey]);

  const diffTarget: DiffTarget = sessionMeta.startSha
    ? { type: "Commit", sha: sessionMeta.startSha }
    : { type: "Head" };

  const activeDiffTab = tabs.find((t) => t.id === activeTabId);
  const isDiffVisible =
    isSessionActive && (activeDiffTab?.kind === "overview" || activeDiffTab?.kind === "review");

  const { data: diffResult } = useWorktreeDiffQuery(
    sessionMeta.projectId,
    sessionMeta.cwd,
    diffTarget,
    { refetchInterval: isDiffVisible ? 10000 : false },
  );

  const diffStats = useMemo(() => {
    if (!diffResult?.diff) return null;
    const files = parseDiffString(diffResult.diff);
    let ins = 0,
      del = 0;
    for (const f of files) {
      const s = computeFileStats(f.hunks);
      ins += s.insertions;
      del += s.deletions;
    }
    return { insertions: ins, deletions: del };
  }, [diffResult]);

  const { data: wslConnections } = useWslConnections();
  const wslDistroName =
    connection.type === "wsl"
      ? (wslConnections?.find((c) => c.id === connection.id)?.distro_name ?? undefined)
      : undefined;

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
      {collapsed ? (
        /* Collapsed: vertical icon strip */
        <div className="flex flex-col items-center py-2 gap-1">
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
          {onMaximizedChange && (
            <button
              type="button"
              title="Maximize panel"
              onClick={() => {
                onMaximizedChange(true);
                onCollapsedChange(false);
              }}
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          )}
        </div>
      ) : (
        /* Expanded: tab bar + content */
        <div className="flex flex-col h-full min-h-0">
          {/* Tab bar */}
          <div className="flex items-center border-b border-border shrink-0 bg-card px-2 py-1.5 gap-2">
            {!maximized && (
              <button
                type="button"
                onClick={() => onCollapsedChange(true)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                title="Collapse panel"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            )}
            <div className="flex items-center bg-muted rounded-lg p-0.75 gap-1 flex-1 overflow-x-auto scrollbar-none min-w-0">
              {tabs.map(({ id, kind, label, closeable }) => {
                const Icon = KIND_ICON[kind];
                const isActive = activeTabId === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onTabChange(id)}
                    className={cn(
                      "relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors shrink-0 z-10",
                      isActive
                        ? "text-accent hover:bg-transparent"
                        : "text-muted-foreground hover:bg-background/50",
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="side-panel-tab-pill"
                        className="absolute inset-0 rounded-md bg-background shadow-sm"
                        transition={{ type: "spring", stiffness: 400, damping: 35 }}
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5" />
                      {label}
                    </span>
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
                          "relative z-10 ml-0.5 w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-muted transition-colors",
                          isActive ? "opacity-50 hover:opacity-100" : "opacity-20 hover:opacity-60",
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
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors shrink-0"
                  title="Add tab"
                >
                  <Plus className="w-3.5 h-3.5" />
                </PopoverTrigger>
                {addTabPopoverContent("bottom")}
              </Popover>
            </div>
            {onMaximizedChange && (
              <button
                type="button"
                onClick={() => onMaximizedChange(!maximized)}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0"
                title={maximized ? "Restore panel" : "Maximize panel"}
              >
                {maximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            )}
          </div>

          {/* Content: all panels mounted, inactive ones hidden */}
          <div className="flex-1 relative min-h-0">
            {tabs.map(({ id, kind }) => {
              const isActive = isSessionActive && activeTabId === id;
              const ptyEntry = kind === "terminal" ? ptyState.get(id) : undefined;
              return (
                <div key={id} className={cn("absolute inset-0", !isActive && "hidden")}>
                  {kind === "overview" && (
                    <OverviewPanel
                      subagentItems={subagentItems}
                      canvasCount={canvasMap.size}
                      changedFilesCount={changedFiles.length}
                      planEntries={planEntries}
                      workingFiles={workingFiles}
                      taskId={taskId}
                      onNavigate={onOpenTabKind}
                      diffStats={diffStats}
                      connection={connection}
                      wslDistroName={wslDistroName}
                    />
                  )}
                  {kind === "plan" && (
                    <div className="absolute inset-0 flex flex-col overflow-hidden">
                      {sidePanelPlan ? (
                        <PermissionPrompt
                          fullHeight
                          requestId={sidePanelPlan.requestId}
                          payload={sidePanelPlan.payload}
                          onRespond={onPlanRespond}
                        />
                      ) : (
                        <div className="flex-1 flex items-center justify-center">
                          <p className="text-xs text-muted-foreground">No plan yet</p>
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
                      isActive={isActive}
                    />
                  )}
                  {kind === "artifacts" && (
                    <ArtifactsPanel
                      files={workingFiles.map((f) => f.path)}
                      sessionKey={sessionKey}
                      isActive={isActive}
                      connection={connection}
                      wslDistroName={wslDistroName}
                    />
                  )}
                  {kind === "files" && (
                    <WorkspaceFilesPanel
                      projectPath={projectPath}
                      connection={connection}
                      wslDistroName={wslDistroName}
                      isActive={isActive}
                    />
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
        </div>
      )}
    </div>
  );
}
