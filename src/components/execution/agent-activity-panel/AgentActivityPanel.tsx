import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { useAcpActivity } from "../activity/useAcpActivity";
import { useAcpSessionLifecycle } from "../activity/useAcpSessionLifecycle";
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

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useSidePanelState } from "./useSidePanelState";
import { useWorkingFileTracker } from "./useWorkingFileTracker";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { usePermissionHandlers } from "./usePermissionHandlers";
import { useMessageSender } from "./useMessageSender";
import { AgentLoadingSkeleton } from "./AgentLoadingSkeleton";
import { AgentStreamContent, getItemKey } from "./AgentStreamContent";
import { AgentBottomBar } from "./AgentBottomBar";
import { AgentScrollOverlays } from "./AgentScrollOverlays";
import {
  MessageScrollerProvider,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/ui/message-scroller";

function ScrollStateWatcher({
  isSelected,
  activeTab,
  activityStatus,
  activitySeen,
  sessionKey,
  markSeen,
  userMessageCount,
  lastAgentSectionId,
}: {
  isSelected: boolean;
  activeTab: string;
  activityStatus: string | undefined;
  activitySeen: boolean | undefined;
  sessionKey: number;
  markSeen: (key: number) => void;
  userMessageCount: number;
  lastAgentSectionId: string | null;
}) {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const scrollable = useMessageScrollerScrollable();

  const prevCountRef = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount > prevCountRef.current) {
      scrollToEnd({ behavior: "instant" });
    }
    prevCountRef.current = userMessageCount;
  }, [userMessageCount, scrollToEnd]);

  const prevIsSelectedRef = useRef(isSelected);
  useLayoutEffect(() => {
    const wasSelected = prevIsSelectedRef.current;
    prevIsSelectedRef.current = isSelected;
    if (!isSelected || wasSelected) return;

    scrollToEnd({ behavior: "instant" });

    if (!lastAgentSectionId) return;
    const sectionEl = document.querySelector(
      `[data-message-id="${CSS.escape(lastAgentSectionId)}"]`,
    );
    if (sectionEl && sectionEl.getBoundingClientRect().top < 0) {
      scrollToMessage(lastAgentSectionId, { align: "start", behavior: "instant" });
    }
  }, [isSelected, lastAgentSectionId, scrollToMessage, scrollToEnd]);

  useEffect(() => {
    if (
      isSelected &&
      activeTab === "agents" &&
      !scrollable.end &&
      activityStatus === "idle" &&
      !activitySeen
    ) {
      markSeen(sessionKey);
    }
  }, [isSelected, activeTab, scrollable.end, activityStatus, activitySeen, sessionKey, markSeen]);
  return null;
}

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

  const [, setScrollRestoreToken] = useState(0);

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

  // Computed early so useSidePanelState can receive it before useSidePanelTabs
  const isPlanPermWithBody = !!(
    pendingPermission &&
    isPlanPermission(pendingPermission.payload) &&
    extractBodyText(pendingPermission.payload) !== null
  );

  const {
    sidePanelCollapsed,
    setSidePanelCollapsed,
    sidePanelRef,
    sidePanelElementRef,
    leftPanelRef,
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
  const userMessageCount = useMemo(
    () => agentSections.filter((s) => s.type === "standalone").length,
    [agentSections],
  );
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

  const handleOpenFile = useCallback(
    (uri: string) => {
      const abs = uri.startsWith("file://") ? uri.slice(7) : uri;
      const base = selectedProject?.path ?? "";
      const rel = base && abs.startsWith(base) ? abs.slice(base.length + 1) : abs;
      addDynamicTab("files", rel);
      setSidePanelCollapsed(false);
    },
    [addDynamicTab, selectedProject, setSidePanelCollapsed],
  );

  const lastUserMessage = useMemo(() => {
    for (let i = agentSections.length - 1; i >= 0; i--) {
      const s = agentSections[i];
      if (s.type === "standalone" && s.item.type === "solo" && s.item.item.type === "userMessage") {
        return s.item.item.item;
      }
    }
    return null;
  }, [agentSections]);

  const lastAgentSectionId = useMemo(() => {
    for (let i = agentSections.length - 1; i >= 0; i--) {
      const s = agentSections[i];
      if (s.type === "agentSection") return getItemKey(s.items[0]);
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

  const hasInlinePermission = !!(pendingPermission && !isPlanPermWithBody);
  const hasPlanOverlay = isPlanPermWithBody && showPlanOverlay;

  const showCompose =
    !isSessionDead &&
    !elicitationContent &&
    !hasInlinePermission &&
    !hasPlanOverlay &&
    !isCenteredCompose;

  const [composeBarHeight, setComposeBarHeight] = useState(0);
  useEffect(() => {
    const el = composeBarWrapperRef.current;
    if (!el) {
      setComposeBarHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (h > 0) setComposeBarHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [showCompose, liveState.isInitializing]);

  if (liveState.isInitializing) return <AgentLoadingSkeleton isNewSession={isNewSession} />;

  const inlinePermission =
    !isSessionDead && hasInlinePermission && pendingPermission ? (
      <motion.div
        key={pendingPermission.requestId}
        className="px-3"
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
        <MessageScrollerProvider autoScroll scrollMargin={10} scrollPreviousItemPeek={0}>
          <ScrollStateWatcher
            isSelected={isSelected}
            activeTab={activeTab}
            activityStatus={activityInfo?.status}
            activitySeen={activityInfo?.seen}
            sessionKey={sessionKey}
            userMessageCount={userMessageCount}
            markSeen={markSeen}
            lastAgentSectionId={lastAgentSectionId}
          />
          <div className="flex-1 relative min-h-0 overflow-hidden">
            <AgentStreamContent
              agentSections={agentSections}
              toolCallMap={liveState.toolCallMap}
              canvasMap={liveState.canvasMap}
              onOpenPlanOverlay={handleOpenPlanOverlaySplit}
              onOpenFile={handleOpenFile}
              inlinePermission={inlinePermission}
              bottomPadding={composeBarHeight}
            />
            <AgentBottomBar
              isSessionDead={isSessionDead}
              showCompose={showCompose}
              composeBarWrapperRef={composeBarWrapperRef}
              composeBarRef={composeBarRef}
              {...sharedComposeBarProps}
            />
            <AgentScrollOverlays
              lastUserMessage={lastUserMessage}
              isCenteredCompose={isCenteredCompose}
              planOverlay={null}
              composeBarRef={composeBarRef}
              {...sharedComposeBarProps}
            />
          </div>
        </MessageScrollerProvider>
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
          elementRef={sidePanelElementRef}
          defaultSize={"60%"}
          minSize={"22rem"}
          collapsible
          collapsedSize="2.75rem"
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
            planTitle={liveState.planTitle}
            onPlanRespond={handlePlanRespond}
            collapsed={sidePanelCollapsed}
            onCollapsedChange={(v) => setSidePanelCollapsed(v)}
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
