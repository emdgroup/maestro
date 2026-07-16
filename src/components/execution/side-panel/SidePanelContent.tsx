import { useState, useEffect, useRef, useMemo } from "react";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { ReviewChangesPanel } from "@/components/execution/activity/ReviewChangesPanel";
import { CanvasRenderer } from "@/components/execution/activity/canvas/CanvasRenderer";
import { PermissionPrompt } from "@/components/execution/activity/PermissionPrompt";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { AcpTerminalView } from "@/components/execution/terminal/AcpTerminalView";
import { OverviewPanel } from "./OverviewPanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import type { CanvasSurface, PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";
import type { ConnectionKey, DiffTarget } from "@/types/bindings";
import { useWorktreeDiffStatsQuery } from "@/services/worktree.service";
import { useWslConnections } from "@/services/connection.service";
import { api } from "@/lib/tauri-utils";
import { commands } from "@/types/bindings";

interface SidePanelContentProps {
  tabs: SidePanelTab[];
  activeTabId: string;
  isSessionActive: boolean;
  sessionKey: number;
  subagentItems: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
  sidePanelPlan: { requestId: string; payload: Record<string, unknown> } | null;
  onPlanRespond: (requestId: string, optionId: string | null) => void;
  canvasMap: Map<string, CanvasSurface>;
  latestCanvasSurfaceId: string | null;
  changedFiles: string[];
  workingFiles: WorkingFileEntry[];
  taskId: number | null;
  projectPath: string;
  connection: ConnectionKey;
  planEntries?: PlanEntry[] | null;
  planTitle?: string | null;
  onCollapsedChange: (c: boolean) => void;
  onOpenTabKind: (kind: TabKind) => void;
  onSpawnShell?: () => Promise<number | null>;
  terminalBuffers?: Map<string, string>;
}

export function SidePanelContent({
  tabs,
  activeTabId,
  isSessionActive,
  sessionKey,
  subagentItems,
  toolCallMap,
  sidePanelPlan,
  onPlanRespond,
  canvasMap,
  latestCanvasSurfaceId,
  changedFiles,
  workingFiles,
  taskId,
  projectPath,
  connection,
  planEntries,
  planTitle,
  onCollapsedChange,
  onOpenTabKind,
  onSpawnShell,
  terminalBuffers,
}: SidePanelContentProps) {
  const [artifactsSelectedFile, setArtifactsSelectedFile] = useState<string | null>(null);
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

  const { data: diffStatsData } = useWorktreeDiffStatsQuery(
    sessionMeta.projectId,
    sessionMeta.cwd,
    diffTarget,
    { refetchInterval: isDiffVisible ? 10000 : false },
  );

  const diffStats = diffStatsData
    ? { insertions: diffStatsData.insertions, deletions: diffStatsData.deletions }
    : null;

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
      if (tab.acpTerminalId) continue; // ACP-managed terminal, no PTY needed
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

  const planContent = useMemo(() => {
    for (const tc of toolCallMap.values()) {
      if (tc.kind === "switch_mode" && typeof tc.rawInput?.plan === "string") {
        return tc.rawInput.plan as string;
      }
    }
    return null;
  }, [toolCallMap]);

  return (
    <>
      {tabs.map(({ id, kind, initialPath, acpTerminalId, isAuthTerminal }) => {
        const isActive = isSessionActive && activeTabId === id;
        const ptyEntry = kind === "terminal" && !acpTerminalId ? ptyState.get(id) : undefined;
        return (
          <div key={id} className={cn("absolute inset-0", !isActive && "hidden")}>
            {kind === "overview" && (
              <OverviewPanel
                subagentItems={subagentItems}
                canvasCount={canvasMap.size}
                changedFilesCount={changedFiles.length}
                planEntries={planEntries}
                planTitle={planTitle}
                workingFiles={workingFiles}
                taskId={taskId}
                onNavigate={(kind, filePath) => {
                  onOpenTabKind(kind);
                  if (kind === "artifacts" && filePath) setArtifactsSelectedFile(filePath);
                }}
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
                ) : planContent ? (
                  <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-4 text-sm">
                    <MarkdownBlock text={planContent} />
                  </div>
                ) : planEntries && planEntries.length > 0 ? (
                  <div className="flex-1 overflow-y-auto custom-scrollbar px-4 py-4">
                    {planTitle && (
                      <div className="text-xs font-medium text-muted-foreground mb-3">
                        {planTitle}
                      </div>
                    )}
                    {planEntries.map((entry, i) => {
                      const isLast = i === planEntries.length - 1;
                      const nextStatus = !isLast ? planEntries[i + 1].status : null;
                      return (
                        <div key={i} className="flex items-stretch min-h-6.5">
                          <div className="flex flex-col items-center w-4.5 shrink-0 pt-0.75">
                            <div
                              className={`w-2 h-2 rounded-full shrink-0 ${
                                entry.status === "completed"
                                  ? "bg-success opacity-70"
                                  : entry.status === "in_progress"
                                    ? "bg-accent animate-pulse"
                                    : "border border-muted-foreground/40"
                              }`}
                            />
                            {!isLast && (
                              <div
                                className={`flex-1 w-0.5 rounded-sm my-0.5 ${
                                  nextStatus === "completed"
                                    ? "bg-success/30"
                                    : nextStatus === "in_progress"
                                      ? "bg-accent/30"
                                      : "bg-muted/50"
                                }`}
                              />
                            )}
                          </div>
                          <div className="flex-1 pb-1.5 pl-2 pt-0.5 min-w-0">
                            <span
                              className={`text-[11px] leading-snug ${
                                entry.status === "completed"
                                  ? "text-muted-foreground/55"
                                  : entry.status === "in_progress"
                                    ? "text-foreground font-semibold"
                                    : "text-muted-foreground"
                              }`}
                            >
                              {entry.content}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
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
                initialFile={artifactsSelectedFile}
              />
            )}
            {kind === "files" && (
              <WorkspaceFilesPanel
                projectPath={projectPath}
                connection={connection}
                wslDistroName={wslDistroName}
                isActive={isActive}
                initialPath={initialPath}
              />
            )}
            {kind === "terminal" && (
              <div className="absolute inset-0">
                {acpTerminalId ? (
                  <AcpTerminalView
                    logId={sessionKey}
                    terminalId={acpTerminalId}
                    initialOutput={terminalBuffers?.get(acpTerminalId) ?? ""}
                    onInput={
                      isAuthTerminal
                        ? (data) => {
                            void commands.acpSendAuthPtyInput(
                              connection,
                              Array.from(new TextEncoder().encode(data)),
                            );
                          }
                        : undefined
                    }
                  />
                ) : ptyEntry?.key != null ? (
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
    </>
  );
}
