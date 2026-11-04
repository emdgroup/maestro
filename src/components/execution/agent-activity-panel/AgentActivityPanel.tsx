import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useAcpActivity } from "../activity/useAcpActivity";
import { useAcpSessionLifecycle } from "../activity/useAcpSessionLifecycle";
import { connectionKeyStr } from "@/lib/connection-utils";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityPlanPanel } from "../activity/ActivityPlanPanel";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { isPlanPermission, extractBodyText } from "../activity/PermissionPrompt";
import {
  extractPlanToolCallId,
  extractBodyTextFromToolCallItem,
} from "../activity/permission-prompt-utils";
import { deriveTaskDraft } from "../activity/task-draft";
import { planLimitsKey, usePlanLimitsStore } from "../activity/planLimits";
import { StopSubagentContext } from "../activity/subagent-stop";
import type { TaskDraft } from "../activity/task-draft";

import { isSubagentToolCall } from "../activity/utils";
import type { UsageState, ToolCallItem } from "../activity/types";
import { cn } from "@/lib/utils";
import { fileUriToPath, splitLineAnchor, toPosixPath } from "@/lib/path-utils";
import {
  openFileWithConnection,
  useArtifactFiles,
  useWslConnections,
} from "@/services/connection.service";
import { opensExternally } from "../activity/fileTypeUtils";
import { useSessionActivity, useSessionActivityActions } from "@/store/sessionActivityStore";
import { useActiveTab } from "@/store/navigationStore";
import { useTauriEvent } from "@/services/tauri-events";
import type { ArtifactFile, JsonValue, ConnectionKey } from "@/types/bindings";
import { ExecutionSidePanel } from "@/components/execution/side-panel/ExecutionSidePanel";
import { SessionPanelContext } from "@/components/execution/side-panel/SessionPanelContext";
import { useSidePanelTabs } from "@/components/execution/side-panel/useSidePanelTabs";
import { CanvasImportDialog } from "@/components/execution/side-panel/CanvasImportDialog";
import { buildAnnotationBlocks } from "@/components/execution/side-panel/annotations/build-annotation-prompt";
import { useAnnotationStore } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";
import { useSessionDiffStats } from "@/components/execution/side-panel/useSessionDiffStats";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/ui/resizable";
import { MessageScrollerProvider } from "@/ui/message-scroller";
import { useLatestRef } from "@/hooks/useLatestRef";

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useSidePanelState } from "./useSidePanelState";
import {
  setAcpConfigOption,
  useAcpSessionMeta,
  useActiveSessionsQuery,
} from "@/services/execution.service";
import { usePermissionHandlers } from "./usePermissionHandlers";
import { useMessageSender } from "./useMessageSender";
import { useAgentAuthFlow } from "./useAgentAuthFlow";
import { useCanvasPrompts } from "./useCanvasPrompts";
import { useStreamSections } from "./useStreamSections";
import { useSidePanelAutoOpen } from "./useSidePanelAutoOpen";
import { useElementHeight } from "@/hooks/useElementHeight";
import { AgentLoadingSkeleton } from "./AgentLoadingSkeleton";
import { AgentStreamContent } from "./AgentStreamContent";
import { AgentBottomBar } from "./AgentBottomBar";
import { AgentScrollOverlays } from "./AgentScrollOverlays";
import { PendingRequestCard } from "./PendingRequestCard";
import { ScrollStateWatcher } from "./ScrollStateWatcher";
import { TaskDraftModal } from "./TaskDraftModal";
import { AgentAuthModal } from "@/components/common/AgentAuthModal";

interface AgentActivityPanelProps {
  sessionId: string;
  agentId: string | null;
  connection: ConnectionKey;
  isSelected?: boolean;
  isNewSession?: boolean;
  onUsageChange?: (usage: UsageState | null) => void;
  headerSlot?: React.ReactNode;
  onSpawnShell?: () => Promise<string | null>;
}

/** One array for "none yet", so the side panel does not see a new list every render. */
const NO_ARTIFACTS: ArtifactFile[] = [];

export function AgentActivityPanel({
  sessionId,
  agentId,
  connection,
  isSelected = false,
  isNewSession = false,
  onUsageChange,
  headerSlot,
  onSpawnShell,
}: AgentActivityPanelProps) {
  const { markSeen } = useSessionActivityActions();
  const activityInfo = useSessionActivity(sessionId);
  const activeTab = useActiveTab();
  const selectedProject = useSelectedProject();

  // The session lifecycle hook only invokes it from ACP event callbacks, well after commit.
  const onUsageChangeRef = useLatestRef(onUsageChange);

  const composeBarRef = useRef<ComposeBarHandle>(null);
  const composeBarWrapperRef = useRef<HTMLDivElement>(null);
  const canvasesRestoredRef = useRef<((surfaceIds: string[]) => void) | undefined>(undefined);

  const [liveState, liveDispatch] = useAcpActivity(sessionId, canvasesRestoredRef);
  const {
    configOptions,
    configValues,
    usageState,
    planLimits,
    availableCommands,
    promptCapabilities,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
    pendingCanvasAwaits,
  } = useAcpSessionLifecycle(sessionId, onUsageChangeRef);

  // Every session of this agent on this connection shares its account's limits, so the header
  // shows the latest any of them heard.
  const connectionId = connectionKeyStr(connection);
  useEffect(() => {
    if (planLimits && agentId) {
      usePlanLimitsStore.getState().record(planLimitsKey(connectionId, agentId), planLimits);
    }
  }, [planLimits, agentId, connectionId]);

  const [, setScrollRestoreToken] = useState(0);

  const pendingSendRef = useRef(false);
  useActivityStatusManager(
    sessionId,
    liveState,
    pendingSendRef,
    !!pendingPermission || !!pendingElicitation,
  );
  const { data: activeSessions } = useActiveSessionsQuery(selectedProject?.id);
  const sessionInfo = activeSessions?.find((s) => s.session_id === sessionId);
  const taskId = sessionInfo?.task_id ?? null;
  const startedAtMs = sessionInfo ? Date.parse(sessionInfo.started_at) : NaN;

  const isSessionActive = isSelected && activeTab === "agents";

  // The session's own working directory, not the project root: an isolated task runs in
  // `<project>/.maestro/worktrees/<name>`, and rooting the file tree at the project instead
  // hid every file the agent actually touched behind a dot-directory the listing prunes.
  // Shares its fetch with `useSessionDiffStats` below. One value feeds both the panel and
  // `handleOpenFile` so the relative paths handed over always match the tree's root.
  const { data: sessionMeta } = useAcpSessionMeta(sessionId);
  const workspacePath = sessionMeta?.cwd ?? selectedProject?.path ?? "";
  const { data: artifactFiles = NO_ARTIFACTS } = useArtifactFiles(
    connection,
    sessionMeta?.cwd,
    Number.isNaN(startedAtMs) ? null : startedAtMs,
    isSessionActive,
  );
  const { data: wslConnections } = useWslConnections();
  const wslDistroName =
    connection.type === "wsl"
      ? (wslConnections?.find((c) => c.id === connection.id)?.distro_name ?? undefined)
      : undefined;

  // Shares its fetch with SidePanelContent's identical call; read here so the Review tab can
  // open itself when the session's first change lands.
  const { changedFilesCount } = useSessionDiffStats(sessionId, isSessionActive);

  // Computed before usePermissionHandlers so we can pass it in to suppress auto-approval
  // Falls back to toolCallMap content when the permission payload snapshot lacks body text
  const isPlanPermWithBody = (() => {
    if (!pendingPermission || !isPlanPermission(pendingPermission.payload)) return false;
    if (extractBodyText(pendingPermission.payload) !== null) return true;
    const id = extractPlanToolCallId(pendingPermission.payload);
    const item = id ? liveState.toolCallMap.get(id) : undefined;
    return !!(item && extractBodyTextFromToolCallItem(item) !== null);
  })();

  // `usePermissionHandlers` reads it only from the respond/submit callbacks, which run after commit.
  const agentItemsCountRef = useLatestRef(liveState.items.length);
  const {
    liveElicitationSummaries,
    livePermissionResponses,
    handlePermissionRespond,
    handleElicitationDecline,
    handleElicitationSubmit,
  } = usePermissionHandlers(
    sessionId,
    agentItemsCountRef,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
    isPlanPermWithBody,
  );

  const {
    sidePanelCollapsed,
    setSidePanelCollapsed,
    expandAuto,
    sidePanelElementRef,
    sidePanelRef,
    syncCollapsedFromPanel,
    groupElementRef,
    maximized,
    sidePanelPlan,
    handleMaximizedChange,
    handleOpenPlanOverlaySplit,
    handlePlanRespond,
  } = useSidePanelState({
    isSelected,
    isPlanPermWithBody,
    pendingPermission,
    handlePermissionRespond,
    setScrollRestoreToken,
  });

  const subagentItems = useMemo(
    () =>
      liveState.items
        .filter(
          (item): item is { type: "toolCall"; item: ToolCallItem } =>
            item.type === "toolCall" &&
            isSubagentToolCall(item.item) &&
            !item.item.parentToolCallId,
        )
        .map((item) => item.item),
    [liveState.items],
  );

  const {
    tabs,
    activeTabId,
    setActiveTabId,
    closeTab,
    openFile,
    openTabKind,
    openAcpTerminalTab,
    latestCanvasSurfaceId,
    unseenTabIds,
    markTabSeen,
  } = useSidePanelTabs({
    hasPlan: !!sidePanelPlan,
    canvasMap: liveState.canvasMap,
    hasArtifacts: artifactFiles.length > 0,
    changedFilesCount,
  });

  useSidePanelAutoOpen({
    isSelected,
    collapsed: sidePanelCollapsed,
    setCollapsed: setSidePanelCollapsed,
    expandAuto,
    activeTabId,
    unseenTabIds,
    markTabSeen,
    openTabKind,
    pendingCanvasAwaits,
  });

  const isProcessing =
    activityInfo?.status === "thinking" ||
    activityInfo?.status === "acting" ||
    activityInfo?.status === "stale";
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);
  // Claude holds the turn open until its background subagents finish, but takes the next prompt
  // meanwhile and ends the held turn with it, so the user need not wait them out.
  const backgroundRunning = useMemo(
    () =>
      [...liveState.toolCallMap.values()].some(
        (tc) => tc.meta?.background && tc.status === "in_progress",
      ),
    [liveState.toolCallMap],
  );

  // `useMessageSender` polls this from a callback while waiting out a cancelled turn, and a value
  // captured in a closure would never change.
  const isTurnActiveRef = useLatestRef(liveState.isTurnActive);
  // `handleSend` reads this to decide whether a "busy" agent is busy working or just parked on a
  // canvas, and it must see the list as it is when the user presses enter.
  const pendingCanvasAwaitsRef = useLatestRef(pendingCanvasAwaits);

  const {
    displayItems,
    agentSections,
    userMessages,
    orderedSectionIds,
    userMessageCount,
    lastUserMessage,
    lastAgentSectionId,
  } = useStreamSections(liveState.items, livePermissionResponses, liveElicitationSummaries);
  // A session waiting on the user is not an empty one, whatever the stream holds. An automation's
  // opens that way: its prompt came from the server rather than from this window, and the request
  // is not a stream item, so the centred composer drew over the card it had to give way to.
  const isCenteredCompose =
    displayItems.length === 0 && !hasSentFirstMessage && !pendingElicitation && !pendingPermission;

  const removeAnnotations = useAnnotationStore((s) => s.removeAnnotations);

  const { handleSend, handleCancel, handleSendWithTransition } = useMessageSender({
    sessionId,
    isProcessing,
    pendingPermission,
    pendingElicitation,
    handlePermissionRespond: handlePermissionRespond,
    liveDispatch,
    isSelected,
    isInitializing: liveState.isInitializing,
    sessionEnded: liveState.sessionEnded,
    composeBarRef,
    isCenteredCompose,
    onCenteredTransition: () => setHasSentFirstMessage(true),
    pendingSendRef,
    isTurnActiveRef,
    canQueue: backgroundRunning,
    pendingCanvasAwaitsRef,
  });

  const handleStopSubagent = useCallback((prompt: string) => void handleSend(prompt), [handleSend]);

  // The Overview's "asks the agent" actions write into the composer instead of prompting, so the
  // user reads and sends what was suggested. Withheld once the session has ended: there would be
  // nothing to receive it, and a box the user can type into but not send is worse than no button.
  const handleSeedPrompt = useCallback(
    (text: string) => {
      composeBarRef.current?.seed(text);
    },
    [composeBarRef],
  );

  // Side-panel annotations: send them as one prompt, then drop the ones that went out.
  //
  // The notes are dropped only after the send resolves, not before it: building the blocks now
  // reads canvas captures off disk and, on a remote session, copies them across, and a failure
  // there must not take the user's notes with it.
  const handleSendAnnotations = useCallback(
    async (annotations: Annotation[]) => {
      if (annotations.length === 0 || isProcessing) return;
      const blocks = await buildAnnotationBlocks(annotations, {
        sessionId: sessionId,
        canSendImages: promptCapabilities?.image ?? false,
      });
      await handleSend("", blocks);
      removeAnnotations(
        sessionId,
        annotations.map((a) => a.id),
      );
    },
    [handleSend, isProcessing, removeAnnotations, sessionId, promptCapabilities],
  );

  const handleConfigChange = useCallback(
    async (optionId: string, value: string) => {
      await setAcpConfigOption(sessionId, optionId, value).catch(() => {
        toast.error("Failed to save config option");
      });
    },
    [sessionId],
  );

  const auth = useAgentAuthFlow({
    sessionId,
    agentId,
    connection,
    taskId,
    items: liveState.items,
    lastUserMessage,
    terminalIds: tabs.map((t) => t.acpTerminalId),
    resend: (content) => void handleSend(content),
  });

  const handleOpenPlanOverlay = useCallback(() => {
    handleOpenPlanOverlaySplit();
    openTabKind("plan");
  }, [handleOpenPlanOverlaySplit, openTabKind]);

  const { handleCanvasEvent, canvasImport } = useCanvasPrompts({
    sessionId,
    canvasMap: liveState.canvasMap,
    sessionEnded: liveState.sessionEnded,
    isProcessing,
    pendingCanvasAwaits,
    liveDispatch,
    handleSend,
    canvasesRestoredRef,
  });

  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null);
  const handleCreateTaskFromText = useCallback((text: string) => {
    setTaskDraft(deriveTaskDraft(text));
  }, []);

  const handleOpenFile = useCallback(
    (uri: string) => {
      // Tool calls report Windows paths with backslashes and an arbitrarily cased
      // drive letter, so compare on a normalised copy: a missed prefix would send
      // an absolute path to a panel that resolves everything against the workspace.
      const { path, lines } = splitLineAnchor(uri);
      const abs = fileUriToPath(path);
      // A spreadsheet or archive has no viewer in the panel, so it goes to the system's own app.
      if (opensExternally(abs)) {
        openFileWithConnection(connection, abs, {
          sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
          wslDistroName,
        }).catch((e) => toast.error(`Could not open ${abs}: ${e}`));
        return;
      }
      const base = toPosixPath(workspacePath).replace(/\/+$/, "");
      const inWorkspace = base !== "" && abs.toLowerCase().startsWith(`${base.toLowerCase()}/`);
      openFile(inWorkspace ? abs.slice(base.length + 1) : abs, lines);
      setSidePanelCollapsed(false);
    },
    [openFile, workspacePath, setSidePanelCollapsed, connection, wslDistroName],
  );

  // The output itself is buffered by the session's runtime; this only opens its tab.
  useTauriEvent<{ terminal_id: string }>(`acp://terminal-output/${sessionId}`, (payload) => {
    const isAuth = payload.terminal_id.startsWith("auth-terminal-");
    openAcpTerminalTab(payload.terminal_id, { isAuthTerminal: isAuth });
  });

  const isSessionDead = liveState.sessionEnded;
  const hasInlinePermission = !!(pendingPermission && !isPlanPermWithBody);
  // A plan review takes the composer's place the same way an inline permission does: the card in
  // the stream is the answer, and a prompt sent while the agent is blocked on the request has
  // nowhere to go (see the cancel-first sequence in `useMessageSender`).
  const hasPendingPlan = !!(pendingPermission && isPlanPermWithBody);
  const hasElicitation = !!pendingElicitation;
  const hasPendingRequest = !isSessionDead && (hasElicitation || !!pendingPermission);

  const showCompose =
    !isSessionDead &&
    !hasElicitation &&
    !hasInlinePermission &&
    !hasPendingPlan &&
    !isCenteredCompose;

  // The bar is also present when a request has replaced the composer, and that card is a
  // different height: the stream reserves room from this measurement, so it has to re-measure
  // when one takes the other's place.
  const composeBarHeight = useElementHeight(
    composeBarWrapperRef,
    [
      showCompose,
      hasInlinePermission,
      hasPendingPlan,
      hasElicitation,
      liveState.isInitializing,
    ].join(),
  );

  // The plan tool call the open request names, so its row can be left out of the stream and shown
  // in the composer's place instead.
  const livePlanToolCallId =
    hasPendingPlan && pendingPermission ? extractPlanToolCallId(pendingPermission.payload) : null;

  const pendingRequestCard = hasPendingRequest ? (
    <PendingRequestCard
      sessionId={sessionId}
      modelId={configValues.model ?? null}
      toolCallMap={liveState.toolCallMap}
      pendingElicitation={pendingElicitation}
      pendingPermission={pendingPermission}
      isPlan={isPlanPermWithBody}
      onElicitationSubmit={handleElicitationSubmit}
      onElicitationDecline={handleElicitationDecline}
      onPlanRespond={handlePlanRespond}
      onOpenPlan={handleOpenPlanOverlay}
      onPermissionRespond={handlePermissionRespond}
    />
  ) : null;

  const sharedComposeBarProps = {
    onSend: handleSendWithTransition as (content: string, contentBlocks?: JsonValue) => void,
    onCancel: handleCancel,
    isProcessing: isProcessing && pendingCanvasAwaits.length === 0,
    canQueue: backgroundRunning,
    commands: availableCommands,
    embeddedContext: promptCapabilities?.embedded_context ?? false,
    sessionId: sessionId,
    projectPath: selectedProject?.path ?? null,
    configOptions,
    configValues,
    usageState,
    onConfigChange: handleConfigChange,
    promptCapabilities,
  };

  const streamContent = liveState.isInitializing ? (
    <AgentLoadingSkeleton isNewSession={isNewSession} />
  ) : (
    <>
      {liveState.plan && (
        <div className="shrink-0 border-b border-accent/10">
          <ActivityPlanPanel entries={liveState.plan} title={liveState.planTitle} />
        </div>
      )}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <MessageScrollerProvider autoScroll scrollMargin={10} scrollPreviousItemPeek={0}>
          <ScrollStateWatcher
            isSelected={isSelected}
            activeTab={activeTab}
            activityStatus={activityInfo?.status}
            activitySeen={activityInfo?.seen}
            sessionId={sessionId}
            userMessageCount={userMessageCount}
            markSeen={markSeen}
            lastAgentSectionId={lastAgentSectionId}
          />
          {/* `data-compose-bounds`: this box clips, and both ComposeBar variants are positioned
              against it, so it is what the composer sizes its growth to. */}
          <div className="flex-1 relative min-h-0 overflow-hidden" data-compose-bounds>
            {/*
              Only the selected session's conversation is rendered. AgentMonitor keeps a panel
              mounted for every ACP session so its listeners and reducer state survive
              navigation, which means without this gate every session's full message tree
              (rendered Markdown, highlighted code, KaTeX, Mermaid) sits in the DOM at once.

              Scoped to the message list rather than the whole panel on purpose: ComposeBar
              holds the unsent draft in local state, and the side panel owns live xterm
              instances, so unmounting either would lose user-visible content. Switching
              sessions re-renders the list from `liveState`, which the still-mounted hooks
              have kept up to date; nothing is refetched.
            */}
            {isSelected && (
              <AgentStreamContent
                agentSections={agentSections}
                toolCallMap={liveState.toolCallMap}
                livePlanToolCallId={livePlanToolCallId}
                onOpenFile={handleOpenFile}
                bottomPadding={composeBarHeight}
                commands={availableCommands}
                projectId={selectedProject?.id}
                workspacePath={workspacePath}
                onAuthLogin={auth.openSignIn}
                onCreateTaskFromText={selectedProject ? handleCreateTaskFromText : undefined}
              />
            )}
            <AgentBottomBar
              isSessionDead={isSessionDead}
              showCompose={showCompose}
              replacement={pendingRequestCard}
              composeBarWrapperRef={composeBarWrapperRef}
              composeBarRef={composeBarRef}
              {...sharedComposeBarProps}
            />
            <AgentScrollOverlays
              userMessages={userMessages}
              orderedSectionIds={orderedSectionIds}
              isSelected={isSelected}
              isCenteredCompose={isCenteredCompose}
              // Measured from the same box the card renders in, so this is its exact height.
              fabLift={pendingRequestCard ? composeBarHeight : 0}
              composeBarRef={composeBarRef}
              {...sharedComposeBarProps}
            />
          </div>
        </MessageScrollerProvider>
      </div>
    </>
  );

  return (
    <StopSubagentContext.Provider value={isSessionDead ? undefined : handleStopSubagent}>
      <div className="flex-1 flex flex-col min-h-0">
        <CanvasImportDialog request={canvasImport.request} onChoice={canvasImport.resolve} />
        {selectedProject && (
          <TaskDraftModal
            draft={taskDraft}
            projectId={selectedProject.id}
            onClose={() => setTaskDraft(null)}
          />
        )}
        {agentId && (
          <AgentAuthModal
            agentId={agentId}
            connection={connection}
            authKey={auth.authKey}
            sessionId={sessionId}
            {...auth.modal}
          />
        )}
        <ResizablePanelGroup
          orientation="horizontal"
          elementRef={groupElementRef}
          disabled={maximized}
          className="relative flex-1 min-h-0 overflow-hidden"
        >
          <ResizablePanel
            minSize="42rem"
            // Hidden under a maximized side panel, which floats over this one and is transparent
            // outside its own inset well.
            className={cn("flex flex-col min-h-0 overflow-hidden", maximized && "invisible")}
          >
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r inner-glass overflow-hidden">
                {headerSlot}
                {streamContent}
              </div>
            </div>
          </ResizablePanel>
          {/*
          Draggable but not drawn: transparent, like the panels either side of it, so the
          window's tint runs through the slot. Collapsed or maximized there is nothing to
          drag between, so it goes away entirely; `disabled` is what suppresses the drag
          target, since the library falls back to the panel edge when a separator is
          missing.
        */}
          <ResizableHandle
            disabled={sidePanelCollapsed || maximized}
            className={cn(
              "bg-transparent hover:bg-transparent",
              (sidePanelCollapsed || maximized) && "hidden",
            )}
          />
          <ResizablePanel
            elementRef={sidePanelElementRef}
            panelRef={sidePanelRef}
            defaultSize={"40%"}
            minSize={"22rem"}
            collapsible
            collapsedSize={"2.75rem"}
            onResize={syncCollapsedFromPanel}
            className={cn(
              "flex flex-col min-h-0 overflow-hidden",
              // Maximized floats the panel over the group; the group keeps the dragged
              // layout underneath for when the panel comes back.
              maximized && "absolute inset-0 z-20",
            )}
          >
            <SessionPanelContext.Provider
              value={{
                sessionId,
                isSessionActive,
                subagentItems,
                toolCallMap: liveState.toolCallMap,
                sidePanelPlan,
                canvasMap: liveState.canvasMap,
                latestCanvasSurfaceId,
                pendingCanvasAwaits,
                onCanvasEvent: handleCanvasEvent,
                onCloseCanvas: (surfaceId) => liveDispatch({ type: "close_canvas", surfaceId }),
                onImportCanvas: canvasImport.importFile,
                workingFiles: artifactFiles,
                taskId,
                workspacePath,
                connection,
                planEntries: liveState.plan,
                planTitle: liveState.planTitle,
                onOpenTabKind: openTabKind,
                onOpenFile: handleOpenFile,
                onSpawnShell,
                terminalBuffers: liveState.terminalBuffers,
                onSendAnnotations: handleSendAnnotations,
                isProcessing,
                canSendImages: promptCapabilities?.image ?? false,
                onSeedPrompt: isSessionDead ? undefined : handleSeedPrompt,
              }}
            >
              <ExecutionSidePanel
                fill
                tabs={tabs}
                activeTabId={activeTabId}
                onTabChange={setActiveTabId}
                onTabClose={closeTab}
                onAddTab={openTabKind}
                collapsed={sidePanelCollapsed}
                onCollapsedChange={(v) => setSidePanelCollapsed(v)}
                unseenTabIds={unseenTabIds}
                maximized={maximized}
                onMaximizedChange={handleMaximizedChange}
              />
            </SessionPanelContext.Provider>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </StopSubagentContext.Provider>
  );
}
