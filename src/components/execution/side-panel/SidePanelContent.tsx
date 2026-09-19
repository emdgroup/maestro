import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { ChevronLeft, ChevronRight, Download, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDraggableFileInput } from "@/components/kanban/shared/useFileInput";
import { ReviewChangesPanel } from "@/components/execution/activity/ReviewChangesPanel";
import { CanvasHtml } from "@/components/execution/activity/canvas/CanvasHtml";
import type {
  CanvasFrameHandle,
  FrameNode,
} from "@/components/execution/activity/canvas/CanvasHtml";
import { CanvasEventContext } from "@/components/execution/activity/canvas/canvas-events";
import type { CanvasEventKind } from "@/components/execution/activity/canvas/canvas-events";
import {
  awaitForSurface,
  awaitToFollow,
} from "@/components/execution/activity/canvas/await-matching";
import type { PendingCanvasAwait } from "@/components/execution/activity/canvas/await-matching";
import { extractBodyText } from "@/components/execution/activity/PermissionPrompt";
import {
  extractPlanToolCallId,
  extractBodyTextFromToolCallItem,
} from "@/components/execution/activity/permission-prompt-utils";
import { TerminalComponent } from "@/components/execution/terminal/Terminal";
import { AcpTerminalView } from "@/components/execution/terminal/AcpTerminalView";
import { OverviewPanel } from "./OverviewPanel";
import { SubagentsPanel } from "./SubagentsPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";
import type { CanvasSurface, PlanEntry, ToolCallItem } from "@/components/execution/activity/types";
import type { WorkingFileEntry } from "@/components/execution/agent-activity-panel/useWorkingFileTracker";
import type { SidePanelTab, TabKind } from "./useSidePanelTabs";
import type { ConnectionKey } from "@/types/bindings";
import { Skeleton } from "@/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";
import { useSessionDiffStats } from "./useSessionDiffStats";
import { useSessionShipState } from "./useSessionShipState";
import { useWslConnections } from "@/services/connection.service";
import {
  useDeleteCanvasSurfaceMutation,
  useExportCanvasSurfaceMutation,
} from "@/services/canvas.service";
import { commands } from "@/types/bindings";
import { useSelectedProject } from "@/store/projectStore";
import type { Annotation } from "@/store/annotationStore";
import { PlanAnnotationLayer } from "./annotations/PlanAnnotationLayer";
import { CanvasAnnotationLayer } from "./annotations/CanvasAnnotationLayer";

interface SidePanelContentProps {
  tabs: SidePanelTab[];
  activeTabId: string;
  isSessionActive: boolean;
  sessionKey: number;
  subagentItems: ToolCallItem[];
  toolCallMap: Map<string, ToolCallItem>;
  /** Set while a plan is awaiting an answer — the tab reads and annotates it, the stream card
   *  answers it. Only the send button's wording depends on this. */
  sidePanelPlan: { requestId: string; payload: Record<string, unknown> } | null;
  canvasMap: Map<string, CanvasSurface>;
  latestCanvasSurfaceId: string | null;
  /** Open `canvas_await` calls — what makes a surface's controls answer rather than just record. */
  pendingCanvasAwaits: PendingCanvasAwait[];
  onCanvasEvent: (requestId: string | null, event: unknown) => void;
  /** Drops the surface from this session's carousel. Its autosaved file is deleted alongside. */
  onCloseCanvas: (surfaceId: string) => void;
  /** Takes a `.html` file on *this* machine and brings it in as a surface. */
  onImportCanvas: (path: string) => void;
  workingFiles: WorkingFileEntry[];
  taskId: number | null;
  workspacePath: string;
  connection: ConnectionKey;
  planEntries?: PlanEntry[] | null;
  planTitle?: string | null;
  onCollapsedChange: (c: boolean) => void;
  onOpenTabKind: (kind: TabKind) => void;
  /** Opens a path (absolute, or project-relative) in a Files tab. */
  onOpenFile: (path: string) => void;
  onSpawnShell?: () => Promise<number | null>;
  terminalBuffers?: Map<string, string>;
  onSendAnnotations: (annotations: Annotation[]) => void;
  /** The agent is mid-turn, so a prompt would be dropped — see useMessageSender.handleSend. */
  isProcessing?: boolean;
  /** The agent takes image blocks, so a canvas region is worth capturing. */
  canSendImages?: boolean;
  /** Puts text in the composer without sending it. Absent when there is no live agent to ask. */
  onSeedPrompt?: (text: string) => void;
  /** Reports a Files tab holding an unsaved draft, so closing it can be guarded. */
  onTabDirtyChange?: (tabId: string, dirty: boolean) => void;
  /** Reports the file a Files tab has open, so the tab can name it on hover. */
  onTabFileChange?: (tabId: string, path: string | null) => void;
}

export function SidePanelContent({
  tabs,
  activeTabId,
  isSessionActive,
  sessionKey,
  subagentItems,
  toolCallMap,
  sidePanelPlan,
  canvasMap,
  latestCanvasSurfaceId,
  pendingCanvasAwaits,
  onCanvasEvent,
  onCloseCanvas,
  onImportCanvas,
  workingFiles,
  taskId,
  workspacePath,
  connection,
  planEntries,
  planTitle,
  onCollapsedChange,
  onOpenTabKind,
  onOpenFile,
  onSpawnShell,
  terminalBuffers,
  onSendAnnotations,
  isProcessing,
  canSendImages,
  onSeedPrompt,
  onTabDirtyChange,
  onTabFileChange,
}: SidePanelContentProps) {
  const [artifactsSelectedFile, setArtifactsSelectedFile] = useState<string | null>(null);
  const selectedProject = useSelectedProject();
  const exportCanvasMutation = useExportCanvasSurfaceMutation();
  const deleteCanvasMutation = useDeleteCanvasSurfaceMutation();

  // Drag-drop is webview-global, so it is accepted only while this session is on screen and the
  // user is looking at a tab an import belongs on. Dropping on Overview opens the canvas tab in
  // the same gesture, since that is where the surface is about to appear.
  const importCanvasFrom = useCallback(
    (path: string) => {
      if (!/\.html?$/i.test(path)) {
        toast.error("Only an .html file can be imported as a canvas");
        return;
      }
      onOpenTabKind("canvas");
      onImportCanvas(path);
    },
    [onOpenTabKind, onImportCanvas],
  );
  const canImportCanvas =
    isSessionActive && (activeTabId === "overview" || activeTabId === "canvas");
  const { isDragging } = useDraggableFileInput(canImportCanvas, (_name, path) =>
    importCanvasFrom(path),
  );
  // Not `pickFiles` from the hook above: that picker takes anything, and the one useful filter
  // here is the file extension the drop path has to check for anyway.
  const browseForCanvas = useCallback(() => {
    void openFilePicker({
      multiple: false,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    }).then((picked) => {
      if (typeof picked === "string") importCanvasFrom(picked);
    });
  }, [importCanvasFrom]);
  // Polling is gated on the session being on screen rather than on the Review or Overview
  // tab being the active one: the Review tab has to be able to raise its unseen dot while
  // the user is looking at another tab, or at a collapsed panel.
  const { diffStats, changedFilesCount, uncommittedFilesCount, scope, isError } =
    useSessionDiffStats(sessionKey, isSessionActive);
  // The pull request state is gated harder than the diff stats above, because it is the one thing
  // here that leaves the machine. Its only consumer is a card on the Overview tab and there is no
  // unseen dot for it to raise, so nothing is lost by asking the forge only while that tab is the
  // one on screen.
  const ship = useSessionShipState(
    sessionKey,
    taskId,
    isProcessing ?? false,
    selectedProject?.path ?? null,
    isSessionActive && activeTabId === "overview",
  );

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
  // Closing the last surface in the carousel would otherwise leave the index past the end, which
  // reads as "No canvas active" while surfaces are still there.
  if (canvasIdx > 0 && canvasIdx >= canvasEntries.length) {
    setCanvasIdx(canvasEntries.length - 1);
  }

  // Page to a surface the agent just produced, but only when that target changes — the
  // user is free to page away afterwards, so the index cannot simply be derived from the
  // latest surface. Latched on the resolved index so a surface whose entry has not landed
  // in `canvasMap` yet is still followed once it does.
  const latestCanvasIdx = latestCanvasSurfaceId
    ? canvasEntries.findIndex(([id]) => id === latestCanvasSurfaceId)
    : -1;
  const [followedCanvasIdx, setFollowedCanvasIdx] = useState(latestCanvasIdx);
  if (followedCanvasIdx !== latestCanvasIdx) {
    setFollowedCanvasIdx(latestCanvasIdx);
    if (latestCanvasIdx >= 0) setCanvasIdx(latestCanvasIdx);
  }

  // Page to the surface the agent is waiting on, the same latch the "latest surface" follow uses
  // — the user can still page away, and is only pulled back when a *new* wait starts.
  const followTarget = awaitToFollow(pendingCanvasAwaits);
  const awaitedCanvasIdx = followTarget
    ? canvasEntries.findIndex(([id]) => id === followTarget.surfaceId)
    : -1;
  const [followedAwaitKey, setFollowedAwaitKey] = useState<string | null>(null);
  const awaitKey = followTarget && awaitedCanvasIdx >= 0 ? followTarget.requestId : null;
  if (followedAwaitKey !== awaitKey) {
    setFollowedAwaitKey(awaitKey);
    if (awaitKey !== null) setCanvasIdx(awaitedCanvasIdx);
  }

  const activeSurface = canvasEntries[canvasIdx]?.[1] ?? null;

  // The surface renders inside a sandboxed frame, so its geometry only exists where the frame
  // reports it. Held here because the annotation layer reads it and the frame produces it.
  const canvasFrameRef = useRef<CanvasFrameHandle | null>(null);
  const [frameNodes, setFrameNodes] = useState<FrameNode[]>([]);
  // Paging the carousel invalidates the geometry: the nodes describe the surface that was on
  // screen, and keeping them would resolve this one's notes against another one's rects. Latched
  // during render so the overlay never paints a frame of the wrong outlines.
  const activeSurfaceKey = activeSurface?.surfaceId ?? null;
  const [measuredSurfaceKey, setMeasuredSurfaceKey] = useState(activeSurfaceKey);
  if (measuredSurfaceKey !== activeSurfaceKey) {
    setMeasuredSurfaceKey(activeSurfaceKey);
    setFrameNodes([]);
  }

  // The agent never sees its rendered surface, so a blocked asset or a thrown exception is only
  // visible here. Parked in the backend and carried back on its next canvas call.
  const reportCanvasError = (surfaceId: string, error: { message: string; source: string }) => {
    void commands.canvasReportError(sessionKey, surfaceId, `${error.source}: ${error.message}`);
  };

  // What the user has entered, per surface. Per surface because they can page between canvases
  // freely: one shared bag would send an answer typed on one form as if it belonged to another,
  // and component ids repeat across surfaces precisely because they are the obvious names.
  const canvasValuesRef = useRef(new Map<string, Record<string, unknown>>());
  const activeSurfaceId = activeSurface?.surfaceId ?? null;
  const activeAwait = awaitForSurface(pendingCanvasAwaits, activeSurfaceId);
  const activeRequestId = activeAwait?.requestId ?? null;
  const canvasEventSink = useMemo(() => {
    if (activeSurfaceId == null) return null;
    // A ref, not state: recording a keystroke must not re-render the surface under the user.
    const values = () => {
      let bag = canvasValuesRef.current.get(activeSurfaceId);
      if (!bag) {
        bag = {};
        canvasValuesRef.current.set(activeSurfaceId, bag);
      }
      return bag;
    };
    return {
      record: (componentId: string, value: unknown) => {
        values()[componentId] = value;
      },
      // Fires on every surface, whether or not a wait covers it. With a wait it answers that
      // wait; without one — a restored session, where the agent is idle and cannot have called
      // `canvas_await` — the panel turns it into a prompt instead, which is the only way a
      // surface that outlived its turn can reach the agent again.
      emit: (componentId: string, kind: CanvasEventKind, value?: unknown) => {
        onCanvasEvent(activeRequestId, {
          surfaceId: activeSurfaceId,
          componentId,
          kind,
          value,
          values: { ...values() },
        });
      },
    };
  }, [activeSurfaceId, activeRequestId, onCanvasEvent]);

  const { planContent, planReviewState, derivedPlanTitle } = useMemo(() => {
    let content: string | null = null;
    let state: "waiting" | "accepted" | "rejected" | null = null;
    for (const tc of toolCallMap.values()) {
      if (tc.kind === "switch_mode") {
        if (typeof tc.rawInput?.plan === "string") content = tc.rawInput.plan as string;
        state =
          tc.status === "completed" ? "accepted" : tc.status === "pending" ? "waiting" : "rejected";
      }
    }
    const titleMatch = content?.match(/^#\s+(.+)/m);
    return {
      planContent: content,
      planReviewState: state,
      derivedPlanTitle: titleMatch ? titleMatch[1].trim() : null,
    };
  }, [toolCallMap]);

  // A pending request carries its own copy of the plan, which is the freshest one. The tool call
  // the stream already holds is the fallback, and the only source once the request is answered.
  const planBody = useMemo(() => {
    if (sidePanelPlan) {
      const fromPayload = extractBodyText(sidePanelPlan.payload);
      if (fromPayload !== null) return fromPayload;
      const id = extractPlanToolCallId(sidePanelPlan.payload);
      const item = id ? toolCallMap.get(id) : undefined;
      const fromItem = item ? extractBodyTextFromToolCallItem(item) : null;
      if (fromItem !== null) return fromItem;
    }
    return planContent;
  }, [sidePanelPlan, toolCallMap, planContent]);

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
                changedFilesCount={changedFilesCount ?? 0}
                planEntries={planEntries}
                planTitle={planTitle ?? derivedPlanTitle}
                planReviewState={planReviewState}
                workingFiles={workingFiles}
                taskId={taskId}
                onNavigate={(kind, filePath) => {
                  onOpenTabKind(kind);
                  if (kind === "artifacts" && filePath) setArtifactsSelectedFile(filePath);
                }}
                diffStats={diffStats}
                uncommittedFilesCount={uncommittedFilesCount}
                scope={scope}
                statsUnavailable={isError}
                connection={connection}
                wslDistroName={wslDistroName}
                ship={ship}
                onSeedPrompt={onSeedPrompt}
              />
            )}
            {kind === "plan" && (
              <div className="absolute inset-0 flex flex-col overflow-hidden">
                {/* Read and annotate only. The request itself is answered from the card in the
                    stream, so a pending plan and a settled one render the same way — all that
                    changes is where the body comes from and what the send button is called. */}
                {planBody ? (
                  <PlanAnnotationLayer
                    className="flex-1"
                    sessionKey={sessionKey}
                    onSend={onSendAnnotations}
                    sendDisabled={isProcessing}
                    sendLabel={sidePanelPlan ? "Revise plan" : undefined}
                  >
                    <MarkdownBlock text={planBody} />
                  </PlanAnnotationLayer>
                ) : planEntries && planEntries.length > 0 ? (
                  <div className="flex-1 overflow-y-auto px-4 py-4">
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
            {kind === "canvas" &&
              (activeSurface ? (
                <CanvasAnnotationLayer
                  sessionKey={sessionKey}
                  surface={activeSurface}
                  frameNodes={frameNodes}
                  frame={canvasFrameRef}
                  onSend={onSendAnnotations}
                  sendDisabled={isProcessing}
                  canCapture={canSendImages}
                  onRequestSurface={(surfaceId) => {
                    const idx = canvasEntries.findIndex(([id]) => id === surfaceId);
                    if (idx >= 0) setCanvasIdx(idx);
                  }}
                  header={{
                    title: (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="text-xs text-muted-foreground truncate min-w-0" />
                          }
                        >
                          {activeSurface.title}
                          {canvasEntries.length > 1 && (
                            <span className="ml-1.5 opacity-60">
                              {canvasIdx + 1} / {canvasEntries.length}
                            </span>
                          )}
                          {/* Every origin this surface may reach through `maestro.fetch`, named
                              where the user can see it. No canvas talks to anything else. */}
                          {activeSurface.sources.map((source) => (
                            <span
                              key={source}
                              className="ml-1.5 rounded-sm bg-muted px-1 py-px text-[10px] font-mono"
                            >
                              {source.replace(/^https?:\/\//, "")}
                            </span>
                          ))}
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{activeSurface.title}</TooltipContent>
                      </Tooltip>
                    ),
                    actions: (
                      <>
                        {canvasEntries.length > 1 && (
                          <>
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
                          </>
                        )}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Export canvas as HTML"
                                disabled={exportCanvasMutation.isPending}
                                onClick={() => exportCanvasMutation.mutate(activeSurface)}
                                className="p-1 rounded text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
                              />
                            }
                          >
                            <Download className="w-3.5 h-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>Export as HTML</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Import a canvas"
                                onClick={browseForCanvas}
                                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                              />
                            }
                          >
                            <Upload className="w-3.5 h-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>Import a canvas</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Close canvas"
                                onClick={() => {
                                  // The state drop and the file are both needed: leaving the file
                                  // behind means `restore_canvases` brings the surface back on the
                                  // next session load.
                                  deleteCanvasMutation.mutate({
                                    logId: sessionKey,
                                    surfaceId: activeSurface.surfaceId,
                                  });
                                  onCloseCanvas(activeSurface.surfaceId);
                                }}
                                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                              />
                            }
                          >
                            <X className="w-3.5 h-3.5" />
                          </TooltipTrigger>
                          <TooltipContent>Close and discard this surface</TooltipContent>
                        </Tooltip>
                      </>
                    ),
                  }}
                >
                  {activeSurface.html.trim().length === 0 ? (
                    <div className="flex flex-col gap-3 p-1">
                      <Skeleton className="h-6 w-3/4" />
                      <Skeleton className="h-32 w-full" />
                      <Skeleton className="h-6 w-1/2" />
                      <Skeleton className="h-24 w-full" />
                    </div>
                  ) : (
                    <CanvasEventContext.Provider value={canvasEventSink}>
                      <CanvasHtml
                        surface={activeSurface}
                        handleRef={canvasFrameRef}
                        onNodes={setFrameNodes}
                        onError={(error) => reportCanvasError(activeSurface.surfaceId, error)}
                      />
                    </CanvasEventContext.Provider>
                  )}
                </CanvasAnnotationLayer>
              ) : (
                <div className="absolute inset-0 p-3">
                  {/* The empty state is the import affordance: with no surface drawn there is
                      nothing else this tab could usefully say. */}
                  <button
                    type="button"
                    onClick={browseForCanvas}
                    className={cn(
                      "flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-xs transition-colors",
                      isDragging
                        ? "border-accent bg-accent/5 text-foreground"
                        : "border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                    )}
                  >
                    <Upload className="w-4 h-4" />
                    <span>Drop a canvas here, or browse</span>
                    <span className="text-[10px] opacity-70">
                      An exported canvas, or any HTML file
                    </span>
                  </button>
                </div>
              ))}
            {kind === "review" && (
              <ReviewChangesPanel
                sessionKey={sessionKey}
                onClose={() => onCollapsedChange(true)}
                compact
                isActive={isActive}
                onSendAnnotations={onSendAnnotations}
                annotationSendDisabled={isProcessing}
                onOpenFile={onOpenFile}
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
                workspacePath={workspacePath}
                connection={connection}
                wslDistroName={wslDistroName}
                isActive={isActive}
                initialPath={initialPath}
                isProcessing={isProcessing}
                onDirtyChange={(dirty) => onTabDirtyChange?.(id, dirty)}
                onSelectedChange={(path) => onTabFileChange?.(id, path)}
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
