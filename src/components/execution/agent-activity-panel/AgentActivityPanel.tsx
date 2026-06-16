import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { useAcpActivity } from "../activity/useAcpActivity";
import { useAcpSessionLifecycle } from "../activity/useAcpSessionLifecycle";
import { useAcpScrollBehavior } from "../activity/useAcpScrollBehavior";
import { useSelectedProject } from "@/store/projectStore";
import { connectionKeyFromProject } from "@/lib/connection-utils";
import { ActivityPlanPanel } from "../activity/ActivityPlanPanel";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { PermissionPrompt, isPlanPermission, extractBodyText } from "../activity/PermissionPrompt";
import {
  ElicitationPrompt,
  parseElicitationFields,
} from "../activity/ElicitationPrompt";
import { groupToolCalls, groupIntoAgentSections, mergeLiveItems } from "../activity/utils";
import type { UsageState } from "../activity/types";
import { api } from "@/lib/tauri-utils";
import { useSessionActivity, useSessionActivityActions } from "@/store/sessionActivityStore";
import { useActiveTab } from "@/store/navigationStore";
import type { JsonValue } from "@/types/bindings";

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useWorkingFileTracker } from "./useWorkingFileTracker";
import { usePermissionHandlers } from "./usePermissionHandlers";
import { useMessageSender } from "./useMessageSender";
import { AgentLoadingSkeleton } from "./AgentLoadingSkeleton";
import { AgentStreamContent } from "./AgentStreamContent";
import { AgentBottomBar } from "./AgentBottomBar";
import { AgentScrollOverlays } from "./AgentScrollOverlays";

interface AgentActivityPanelProps {
  sessionKey: number;
  agentId: string | null;
  isSelected?: boolean;
  onUsageChange?: (usage: UsageState | null) => void;
  onWorkingFilesChange?: (sessionKey: number, files: string[]) => void;
  onSessionChangedFilesChange?: (sessionKey: number, files: string[]) => void;
  onOpenPanel?: (panel: "working-files" | "review-changes", initialFile?: string) => void;
}

export function AgentActivityPanel({
  sessionKey,
  agentId,
  isSelected = false,
  onUsageChange,
  onWorkingFilesChange,
  onSessionChangedFilesChange,
  onOpenPanel,
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
  const connection = selectedProject
    ? connectionKeyFromProject(selectedProject)
    : { type: "local" as const };
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
  } = useAcpSessionLifecycle(sessionKey, agentId, connection, onUsageChangeRef, sessionUpdateRef);

  const isReady = !liveState.isInitializing;
  const scroll = useAcpScrollBehavior(isReady, liveState.lastUserMessageId);

  useActivityStatusManager(sessionKey, liveState);
  useWorkingFileTracker(
    sessionKey,
    liveState.items,
    onWorkingFilesChange,
    onSessionChangedFilesChange,
  );

  const {
    liveElicitationSummaries,
    livePermissionResponses,
    showPlanOverlay,
    handlePermissionRespond,
    handleElicitationDecline,
    handleElicitationSubmit,
    setShowPlanOverlay,
  } = usePermissionHandlers(
    sessionKey,
    agentItemsCountRef,
    pendingPermission,
    setPendingPermission,
    pendingElicitation,
    setPendingElicitation,
  );

  const isProcessing = activityInfo?.status === "thinking" || activityInfo?.status === "acting";
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);

  agentItemsCountRef.current = liveState.items.length;

  const displayItems = useMemo(
    () => mergeLiveItems(liveState.items, livePermissionResponses, liveElicitationSummaries),
    [liveState.items, livePermissionResponses, liveElicitationSummaries],
  );
  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);
  const agentSections = useMemo(() => groupIntoAgentSections(groupedItems), [groupedItems]);
  const isCenteredCompose =
    !liveState.isInitializing && displayItems.length === 0 && !hasSentFirstMessage;

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

  if (liveState.isInitializing) return <AgentLoadingSkeleton />;

  const isSessionDead = liveState.sessionEnded;
  const elicitationContent = pendingElicitation
    ? (() => {
        const { fields, otherField } = parseElicitationFields(pendingElicitation.payload);
        return {
          requestId: pendingElicitation.requestId,
          message: pendingElicitation.message,
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

  const showCompose =
    !isSessionDead &&
    !elicitationContent &&
    !hasInlinePermission &&
    !hasPlanOverlay &&
    !isCenteredCompose;

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

  const planOverlay =
    hasPlanOverlay && pendingPermission ? (
      <PermissionPrompt
        requestId={pendingPermission.requestId}
        payload={pendingPermission.payload}
        onRespond={handlePermissionRespond}
        fullHeight
      />
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

  return (
    <div className="flex-1 flex flex-col min-h-0">
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
            onOpenPlanOverlay={() => setShowPlanOverlay(true)}
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
            onOpenPanel={onOpenPanel}
          />
          <AgentScrollOverlays
            showScrollFab={scroll.showScrollFab}
            hasUnread={scroll.hasUnread}
            scrollToBottom={scroll.scrollToBottom}
            isLastUserMsgPinned={scroll.isLastUserMsgPinned}
            lastUserMessage={lastUserMessage}
            scrollToLastUserMsg={scroll.scrollToLastUserMsg}
            isCenteredCompose={isCenteredCompose}
            planOverlay={planOverlay}
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
    </div>
  );
}
