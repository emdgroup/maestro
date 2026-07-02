import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { useAcpActivity } from "../activity/useAcpActivity";
import { useAcpSessionLifecycle } from "../activity/useAcpSessionLifecycle";
import { useAcpScrollBehavior } from "../activity/useAcpScrollBehavior";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityPlanPanel } from "../activity/ActivityPlanPanel";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { PermissionPrompt, isPlanPermission, extractBodyText } from "../activity/PermissionPrompt";
import { ElicitationPrompt, parseElicitationFields } from "../activity/ElicitationPrompt";
import {
  groupToolCalls,
  groupIntoAgentSections,
  mergeLiveItems,
  isSubagentToolCall,
} from "../activity/utils";
import type { UsageState, ToolCallItem } from "../activity/types";
import { api } from "@/lib/tauri-utils";
import { useSessionActivity, useSessionActivityActions } from "@/store/sessionActivityStore";
import { useActiveTab } from "@/store/navigationStore";
import type { JsonValue, ConnectionKey } from "@/types/bindings";
import { ExecutionSidePanel } from "@/components/execution/side-panel/ExecutionSidePanel";
import { useSidePanelTabs } from "@/components/execution/side-panel/useSidePanelTabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useWorkingFileTracker } from "./useWorkingFileTracker";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { usePermissionHandlers } from "./usePermissionHandlers";
import { useMessageSender } from "./useMessageSender";
import { AgentLoadingSkeleton } from "./AgentLoadingSkeleton";
import { AgentStreamContent } from "./AgentStreamContent";
import { AgentBottomBar } from "./AgentBottomBar";
import { AgentScrollOverlays } from "./AgentScrollOverlays";

interface AgentActivityPanelProps {
  sessionKey: number;
  agentId: string | null;
  connection: ConnectionKey;
  isSelected?: boolean;
  isNewSession?: boolean;
  onUsageChange?: (usage: UsageState | null) => void;
  headerSlot?: React.ReactNode;
  onSpawnShell?: () => Promise<number | null>;
}

export function AgentActivityPanel({
  sessionKey,
  connection,
  isSelected = false,
  isNewSession = false,
  onUsageChange,
  headerSlot,
  onSpawnShell,
}: AgentActivityPanelProps) {
  const { markSeen } = useSessionActivityActions();
  const activityInfo = useSessionActivity(sessionKey);
  const activeTab = useActiveTab();
  const selectedProject = useSelectedProject();

  const onUsageChangeRef = useRef(onUsageChange);
  onUsageChangeRef.current = onUsageChange;

  const composeBarRef = useRef<ComposeBarHandle>(null);
  const composeBarWrapperRef = useRef<HTMLDivElement>(null);
  const agentItemsCountRef = useRef(0);
  const sessionUpdateRef = useRef<((payload: Record<string, unknown>) => void) | undefined>(
    undefined,
  );

  const [liveState, liveDispatch] = useAcpActivity(sessionKey, sessionUpdateRef);
  const {
    configOptions,
    configValues,
    usageState,
    availableCommands,
    promptCapabilities,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
  } = useAcpSessionLifecycle(sessionKey, onUsageChangeRef, sessionUpdateRef);

  const isReady = !liveState.isInitializing;
  const [scrollRestoreToken, setScrollRestoreToken] = useState(0);
  const scroll = useAcpScrollBehavior(isReady, liveState.lastUserMessageId, scrollRestoreToken);

  useActivityStatusManager(sessionKey, liveState);
  const { workingFiles: localWorkingFiles, sessionChangedFiles: localChangedFiles } =
    useWorkingFileTracker(sessionKey, liveState.items);

  const { data: activeSessions } = useActiveSessionsQuery(selectedProject?.id);
  const taskId = useMemo(() => {
    const info = activeSessions?.find((s) => s.session_key === sessionKey);
    return info?.task_id ?? null;
  }, [activeSessions, sessionKey]);

  const isSessionActive = isSelected && activeTab === "agents";

  const {
    liveElicitationSummaries,
    livePermissionResponses,
    showPlanOverlay,
    handlePermissionRespond,
    handleElicitationDecline,
    handleElicitationSubmit,
  } = usePermissionHandlers(
    sessionKey,
    agentItemsCountRef,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
  );

  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(isNewSession);
  const sidePanelRef = useRef<PanelImperativeHandle>(null);
  const leftPanelRef = useRef<PanelImperativeHandle>(null);
  const [maximized, setMaximized] = useState(false);
  const [sidePanelPlan, setSidePanelPlan] = useState<{
    requestId: string;
    payload: Record<string, unknown>;
  } | null>(null);

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

  const autoExpandPendingRef = useRef(isNewSession);
  const hasOverviewCard =
    subagentItems.length > 0 ||
    liveState.canvasMap.size > 0 ||
    localChangedFiles.length > 0 ||
    (liveState.plan?.length ?? 0) > 0 ||
    localWorkingFiles.length > 0;
  useEffect(() => {
    if (autoExpandPendingRef.current && hasOverviewCard) {
      autoExpandPendingRef.current = false;
      setSidePanelCollapsed(false);
    }
  }, [hasOverviewCard]);

  // Any manual user interaction with the panel cancels the pending auto-expand
  const handleSidePanelCollapsedChange = useCallback((v: boolean) => {
    autoExpandPendingRef.current = false;
    setSidePanelCollapsed(v);
  }, []);

  const {
    tabs,
    activeTabId,
    setActiveTabId,
    closeTab,
    addDynamicTab,
    openTabKind,
    latestCanvasSurfaceId,
  } = useSidePanelTabs({
    hasPlan: !!sidePanelPlan,
    canvasMap: liveState.canvasMap,
    hasArtifacts: localWorkingFiles.length > 0,
  });

  const isProcessing =
    activityInfo?.status === "thinking" ||
    activityInfo?.status === "acting" ||
    activityInfo?.status === "stale";
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);

  agentItemsCountRef.current = liveState.items.length;

  const displayItems = useMemo(
    () => mergeLiveItems(liveState.items, livePermissionResponses, liveElicitationSummaries),
    [liveState.items, livePermissionResponses, liveElicitationSummaries],
  );
  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);
  const agentSections = useMemo(() => groupIntoAgentSections(groupedItems), [groupedItems]);
  const isCenteredCompose = displayItems.length === 0 && !hasSentFirstMessage;

  const { handleCancel, handleSendWithTransition } = useMessageSender({
    sessionKey,
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
  });

  const handleConfigChange = useCallback(
    async (optionId: string, value: string) => {
      await api.setAcpConfigOption(sessionKey, optionId, value).catch(() => {
        toast.error("Failed to save config option");
      });
    },
    [sessionKey],
  );

  const handleOpenPlanOverlaySplit = useCallback(() => {
    if (!pendingPermission) return;
    if (!extractBodyText(pendingPermission.payload)) return;
    setSidePanelPlan({
      requestId: pendingPermission.requestId,
      payload: pendingPermission.payload,
    });
    setSidePanelCollapsed(false);
  }, [pendingPermission]);

  const handlePlanRespond = useCallback(
    (requestId: string, optionId: string | null) => {
      void handlePermissionRespond(requestId, optionId);
      setSidePanelPlan(null);
    },
    [handlePermissionRespond],
  );

  useEffect(() => {
    if (
      isSelected &&
      activeTab === "agents" &&
      !scroll.hasUnread &&
      activityInfo?.status === "idle" &&
      !activityInfo?.seen
    ) {
      markSeen(sessionKey);
    }
  }, [
    isSelected,
    activeTab,
    scroll.hasUnread,
    activityInfo?.status,
    activityInfo?.seen,
    sessionKey,
    markSeen,
  ]);

  // When compose bar grows (multiline), keep stream tail visible if auto-scroll is active.
  // chatScrollRef and atBottomRef are stable refs — intentionally omitted from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = composeBarWrapperRef.current;
    const scrollEl = scroll.chatScrollRef.current;
    if (!el || !scrollEl) return;
    const ro = new ResizeObserver(() => {
      if (scroll.atBottomRef.current) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isReady, isCenteredCompose, scroll]);

  const lastUserMessage = useMemo(() => {
    for (let i = agentSections.length - 1; i >= 0; i--) {
      const s = agentSections[i];
      if (s.type === "standalone" && s.item.type === "solo" && s.item.item.type === "userMessage") {
        return s.item.item.item;
      }
    }
    return null;
  }, [agentSections]);

  const handleForceEnd = useCallback(async () => {
    await api.cancelAcpSession(sessionKey).catch(() => {});
  }, [sessionKey]);

  const isSessionDead = liveState.sessionEnded;
  const elicitationContent = pendingElicitation
    ? (() => {
        const { requestId, message, payload } = pendingElicitation;
        const { fields, otherField } = parseElicitationFields(payload);
        return {
          requestId,
          message,
          fields,
          otherField,
        };
      })()
    : null;

  const isPlanPermWithBody = !!(
    pendingPermission &&
    isPlanPermission(pendingPermission.payload) &&
    extractBodyText(pendingPermission.payload) !== null
  );
  const hasInlinePermission = !!(pendingPermission && !isPlanPermWithBody);
  const hasPlanOverlay = isPlanPermWithBody && showPlanOverlay;

  useEffect(() => {
    if (sidePanelCollapsed && !sidePanelRef.current?.isCollapsed()) {
      sidePanelRef.current?.collapse();
    } else if (!sidePanelCollapsed && sidePanelRef.current?.isCollapsed()) {
      sidePanelRef.current?.expand();
    }
  }, [sidePanelCollapsed]);

  useEffect(() => {
    if (isSelected) {
      setMaximized(false);
      if (leftPanelRef.current?.isCollapsed()) {
        leftPanelRef.current?.expand();
      }
    }
  }, [isSelected]);

  function handleMaximizedChange(v: boolean) {
    setMaximized(v);
    if (v) {
      setSidePanelCollapsed(false);
      leftPanelRef.current?.collapse();
    } else {
      leftPanelRef.current?.expand();
    }
  }

  // Restore scroll position after panel collapse/expand.
  // chatScrollRef and scrollTopRef are stable refs — safe to omit from deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = scroll.chatScrollRef.current;
    if (el) el.scrollTop = scroll.scrollTopRef.current;
  }, [sidePanelCollapsed]);

  useEffect(() => {
    setScrollRestoreToken((v) => v + 1);
  }, [sidePanelCollapsed]);

  useEffect(() => {
    if (!isPlanPermWithBody || !pendingPermission) return;
    if (!extractBodyText(pendingPermission.payload)) return;
    setSidePanelPlan({
      requestId: pendingPermission.requestId,
      payload: pendingPermission.payload,
    });
    setSidePanelCollapsed(false);
  }, [isPlanPermWithBody, pendingPermission]);

  const showCompose =
    !isSessionDead &&
    !elicitationContent &&
    !hasInlinePermission &&
    !hasPlanOverlay &&
    !isCenteredCompose;

  if (liveState.isInitializing) return <AgentLoadingSkeleton isNewSession={isNewSession} />;

  const inlinePermission =
    !isSessionDead && hasInlinePermission && pendingPermission ? (
      <motion.div
        key={pendingPermission.requestId}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
      >
        <PermissionPrompt
          requestId={pendingPermission.requestId}
          payload={pendingPermission.payload}
          onRespond={handlePermissionRespond}
        />
      </motion.div>
    ) : null;

  const sharedComposeBarProps = {
    onSend: handleSendWithTransition as (content: string, contentBlocks?: JsonValue) => void,
    onCancel: handleCancel,
    isProcessing,
    commands: availableCommands,
    embeddedContext: promptCapabilities?.embedded_context ?? false,
    logId: sessionKey,
    projectPath: selectedProject?.path ?? null,
    configOptions,
    configValues,
    usageState,
    onConfigChange: handleConfigChange,
    promptCapabilities,
  };

  const isStale = activityInfo?.status === "stale";

  const streamContent = (
    <>
      {liveState.plan && (
        <div className="shrink-0 bg-card border-b border-border">
          <ActivityPlanPanel entries={liveState.plan} title={liveState.planTitle} />
        </div>
      )}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 relative min-h-0 overflow-hidden">
          <AgentStreamContent
            agentSections={agentSections}
            lastUserMessage={lastUserMessage}
            toolCallMap={liveState.toolCallMap}
            canvasMap={liveState.canvasMap}
            onOpenPlanOverlay={handleOpenPlanOverlaySplit}
            inlinePermission={inlinePermission}
            bottomBar={
              <AgentBottomBar
                isSessionDead={isSessionDead}
                showCompose={showCompose}
                composeBarWrapperRef={composeBarWrapperRef}
                composeBarRef={composeBarRef}
                {...sharedComposeBarProps}
              />
            }
            chatScrollRef={scroll.chatScrollRef}
            chatContentRef={scroll.chatContentRef}
            lastUserMsgRef={scroll.lastUserMsgRef}
            handleWheel={scroll.handleWheel}
            handleChatScroll={scroll.handleChatScroll}
          />
          <AgentScrollOverlays
            showScrollFab={scroll.showScrollFab}
            hasUnread={scroll.hasUnread}
            scrollToBottom={scroll.scrollToBottom}
            isLastUserMsgPinned={scroll.isLastUserMsgPinned}
            lastUserMessage={lastUserMessage}
            scrollToLastUserMsg={scroll.scrollToLastUserMsg}
            isCenteredCompose={isCenteredCompose}
            planOverlay={null}
            composeBarRef={composeBarRef}
            {...sharedComposeBarProps}
          />
        </div>
        <AnimatePresence>
          {elicitationContent && !isSessionDead && (
            <motion.div
              className="shrink-0 overflow-hidden"
              initial={{ height: 0 }}
              animate={{ height: "auto" }}
              exit={{ height: 0 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <ElicitationPrompt
                requestId={elicitationContent.requestId}
                message={elicitationContent.message}
                fields={elicitationContent.fields}
                otherField={elicitationContent.otherField}
                onSubmit={handleElicitationSubmit}
                onDecline={handleElicitationDecline}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {isStale && (
        <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive">
          <span>Connection lost — agent may be stuck</span>
          <button
            onClick={handleForceEnd}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium border border-destructive/40 hover:bg-destructive/20 transition-colors"
          >
            Force end session
          </button>
        </div>
      )}
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0 overflow-hidden">
        <ResizablePanel
          panelRef={leftPanelRef}
          defaultSize={65}
          minSize="42rem"
          collapsible
          collapsedSize={0}
          className="flex flex-col min-h-0 overflow-hidden"
        >
          {headerSlot}
          {streamContent}
        </ResizablePanel>
        {!maximized && <ResizableHandle withHandle />}
        <ResizablePanel
          panelRef={sidePanelRef}
          defaultSize={35}
          minSize={15}
          collapsible
          collapsedSize="2.75rem"
          onResize={(panelSize) => setSidePanelCollapsed(panelSize.inPixels <= 60)}
          className="flex flex-col min-h-0 overflow-hidden"
        >
          <ExecutionSidePanel
            fill
            sessionKey={sessionKey}
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={setActiveTabId}
            onTabClose={closeTab}
            onAddTab={addDynamicTab}
            onOpenTabKind={openTabKind}
            workingFiles={localWorkingFiles}
            taskId={taskId}
            changedFiles={localChangedFiles}
            projectPath={selectedProject?.path ?? ""}
            connection={connection}
            canvasMap={liveState.canvasMap}
            latestCanvasSurfaceId={latestCanvasSurfaceId}
            subagentItems={subagentItems}
            toolCallMap={liveState.toolCallMap}
            sidePanelPlan={sidePanelPlan}
            planEntries={liveState.plan}
            onPlanRespond={handlePlanRespond}
            collapsed={sidePanelCollapsed}
            onCollapsedChange={handleSidePanelCollapsedChange}
            maximized={maximized}
            onMaximizedChange={handleMaximizedChange}
            onSpawnShell={onSpawnShell}
            isSessionActive={isSessionActive}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
