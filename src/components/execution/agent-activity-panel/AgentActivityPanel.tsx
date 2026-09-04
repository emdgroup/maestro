import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import { useAcpActivity } from "../activity/useAcpActivity";
import { useAcpSessionLifecycle } from "../activity/useAcpSessionLifecycle";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityPlanPanel } from "../activity/ActivityPlanPanel";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { PermissionPrompt, isPlanPermission, extractBodyText } from "../activity/PermissionPrompt";
import {
  extractPlanToolCallId,
  extractBodyTextFromToolCallItem,
} from "../activity/permission-prompt-utils";
import { ElicitationPrompt, parseElicitationFields } from "../activity/ElicitationPrompt";
import {
  groupToolCalls,
  groupIntoAgentSections,
  mergeLiveItems,
  isSubagentToolCall,
} from "../activity/utils";
import type { UsageState, ToolCallItem, UserMessageItem } from "../activity/types";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/utils.ts";
import { toPosixPath } from "@/lib/path-utils";
import { useSessionActivity, useSessionActivityActions } from "@/store/sessionActivityStore";
import { useActiveTab } from "@/store/navigationStore";
import { useBoardActions, useBoardStore } from "@/store/boardStore";
import { commands } from "@/types/bindings";
import type { JsonValue, ConnectionKey } from "@/types/bindings";
import { ExecutionSidePanel } from "@/components/execution/side-panel/ExecutionSidePanel";
import { useSidePanelTabs } from "@/components/execution/side-panel/useSidePanelTabs";
import { buildAnnotationBlocks } from "@/components/execution/side-panel/annotations/build-annotation-prompt";
import { useAnnotationStore } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";
import { useSessionDiffStats } from "@/components/execution/side-panel/useSessionDiffStats";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useSidePanelState } from "./useSidePanelState";
import { useWorkingFileTracker } from "./useWorkingFileTracker";
import { useAcpSessionMeta, useActiveSessionsQuery } from "@/services/execution.service";
import { usePermissionHandlers } from "./usePermissionHandlers";
import { useMessageSender } from "./useMessageSender";
import { AgentLoadingSkeleton } from "./AgentLoadingSkeleton";
import { AgentStreamContent, getItemKey } from "./AgentStreamContent";
import { AgentBottomBar } from "./AgentBottomBar";
import { AgentScrollOverlays } from "./AgentScrollOverlays";
import { AgentAuthModal } from "@/components/common/AgentAuthModal";
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
  }, [isSelected, scrollToEnd]);

  useEffect(() => {
    if (!isSelected || !lastAgentSectionId) return;
    const id = requestAnimationFrame(() => {
      const sectionEl = document.querySelector(
        `[data-message-id="${CSS.escape(lastAgentSectionId)}"]`,
      );
      if (sectionEl && sectionEl.getBoundingClientRect().top < 0) {
        scrollToMessage(lastAgentSectionId, { align: "start", behavior: "instant" });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [isSelected, lastAgentSectionId, scrollToMessage]);

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
  agentId,
  connection,
  isSelected = false,
  isNewSession = false,
  onUsageChange,
  headerSlot,
  onSpawnShell,
}: AgentActivityPanelProps) {
  const { markSeen } = useSessionActivityActions();
  const {
    setAuthRequired,
    clearAuthRequired,
    setAuthTerminalInterrupted,
    setAuthTerminalIdle,
    setPendingSessionRetry,
  } = useBoardActions();
  const authRequiredTasks = useBoardStore((s) => s.authRequiredTasks);
  const activityInfo = useSessionActivity(sessionKey);
  const activeTab = useActiveTab();
  const selectedProject = useSelectedProject();

  // Mirrored from an effect rather than assigned during render — the session
  // lifecycle hook only invokes it from ACP event callbacks, well after commit.
  const onUsageChangeRef = useRef(onUsageChange);
  useEffect(() => {
    onUsageChangeRef.current = onUsageChange;
  });

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

  const pendingSendRef = useRef(false);
  useActivityStatusManager(
    sessionKey,
    liveState,
    pendingSendRef,
    !!pendingPermission || !!pendingElicitation,
  );
  const { workingFiles: localWorkingFiles } = useWorkingFileTracker(sessionKey, liveState.items);

  const { data: activeSessions } = useActiveSessionsQuery(selectedProject?.id);
  const taskId = useMemo(() => {
    const info = activeSessions?.find((s) => s.session_key === sessionKey);
    return info?.task_id ?? null;
  }, [activeSessions, sessionKey]);

  const isSessionActive = isSelected && activeTab === "agents";

  // The session's own working directory, not the project root: an isolated task runs in
  // `<project>/.maestro/worktrees/<name>`, and rooting the file tree at the project instead
  // hid every file the agent actually touched behind a dot-directory the listing prunes.
  // Shares its fetch with `useSessionDiffStats` below. One value feeds both the panel and
  // `handleOpenFile` so the relative paths handed over always match the tree's root.
  const { data: sessionMeta } = useAcpSessionMeta(sessionKey);
  const workspacePath = sessionMeta?.cwd ?? selectedProject?.path ?? "";

  // Shares its fetch with SidePanelContent's identical call; read here so the Review tab can
  // open itself when the session's first change lands.
  const { changedFilesCount } = useSessionDiffStats(sessionKey, isSessionActive);

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [hasPreSpawnAuthError, setHasPreSpawnAuthError] = useState(false);

  const effectiveAuthKey = taskId ?? sessionKey;

  const lastItem = liveState.items[liveState.items.length - 1];
  const hasAuthError = liveState.items.some(
    (item) => item.type === "error" && item.item.stopReason === "auth_required",
  );

  // Computed before usePermissionHandlers so we can pass it in to suppress auto-approval
  // Falls back to toolCallMap content when the permission payload snapshot lacks body text
  const isPlanPermWithBody = (() => {
    if (!pendingPermission || !isPlanPermission(pendingPermission.payload)) return false;
    if (extractBodyText(pendingPermission.payload) !== null) return true;
    const id = extractPlanToolCallId(pendingPermission.payload);
    const item = id ? liveState.toolCallMap.get(id) : undefined;
    return !!(item && extractBodyTextFromToolCallItem(item) !== null);
  })();

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
    addDynamicTab,
    openTabKind,
    openAcpTerminalTab,
    latestCanvasSurfaceId,
    unseenTabIds,
    markTabSeen,
  } = useSidePanelTabs({
    hasPlan: !!sidePanelPlan,
    canvasMap: liveState.canvasMap,
    hasArtifacts: localWorkingFiles.length > 0,
    changedFilesCount,
  });

  // A visible tab has been seen; a new one only pulls the panel open when there is room.
  useEffect(() => {
    if (!sidePanelCollapsed) markTabSeen(activeTabId);
  }, [sidePanelCollapsed, activeTabId, markTabSeen]);

  useEffect(() => {
    if (unseenTabIds.size > 0) expandAuto();
    // isSelected: a tab that arrived while this session was hidden could not measure
    // the group, so retry once it is on screen.
  }, [unseenTabIds, expandAuto, isSelected]);

  const isProcessing =
    activityInfo?.status === "thinking" ||
    activityInfo?.status === "acting" ||
    activityInfo?.status === "stale";
  const [hasSentFirstMessage, setHasSentFirstMessage] = useState(false);

  // Mirrored from an effect rather than assigned during render — `usePermissionHandlers`
  // reads it only from the respond/submit callbacks, which run after commit.
  useEffect(() => {
    agentItemsCountRef.current = liveState.items.length;
  });

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

  const removeAnnotations = useAnnotationStore((s) => s.removeAnnotations);

  const { handleSend, handleCancel, handleSendWithTransition } = useMessageSender({
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
    pendingSendRef,
  });

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
        logId: sessionKey,
        canSendImages: promptCapabilities?.image ?? false,
      });
      await handleSend("", blocks);
      removeAnnotations(
        sessionKey,
        annotations.map((a) => a.id),
      );
    },
    [handleSend, isProcessing, removeAnnotations, sessionKey, promptCapabilities],
  );

  const handleConfigChange = useCallback(
    async (optionId: string, value: string) => {
      await api.setAcpConfigOption(sessionKey, optionId, value).catch(() => {
        toast.error("Failed to save config option");
      });
    },
    [sessionKey],
  );

  const handleOpenPlanOverlay = useCallback(() => {
    handleOpenPlanOverlaySplit();
    openTabKind("plan");
  }, [handleOpenPlanOverlaySplit, openTabKind]);

  const handleOpenFile = useCallback(
    (uri: string) => {
      // Tool calls report Windows paths with backslashes and an arbitrarily cased
      // drive letter, so compare on a normalised copy — a missed prefix would send
      // an absolute path to a panel that resolves everything against the workspace.
      const abs = toPosixPath(uri.startsWith("file://") ? uri.slice(7) : uri);
      const base = toPosixPath(workspacePath).replace(/\/+$/, "");
      const inWorkspace = base !== "" && abs.toLowerCase().startsWith(`${base.toLowerCase()}/`);
      addDynamicTab("files", inWorkspace ? abs.slice(base.length + 1) : abs);
      setSidePanelCollapsed(false);
    },
    [addDynamicTab, workspacePath, setSidePanelCollapsed],
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

  const userMessages = useMemo(() => {
    const msgs: UserMessageItem[] = [];
    for (const section of agentSections) {
      if (
        section.type === "standalone" &&
        section.item.type === "solo" &&
        section.item.item.type === "userMessage"
      ) {
        msgs.push(section.item.item.item);
      }
    }
    return msgs;
  }, [agentSections]);

  const orderedSectionIds = useMemo(() => {
    const ids: string[] = [];
    for (const section of agentSections) {
      if (section.type === "standalone") {
        const gi = section.item;
        if (gi.type === "solo" && gi.item.type === "userMessage") {
          ids.push(gi.item.item.id);
        }
      } else {
        ids.push(getItemKey(section.items[0]));
      }
    }
    return ids;
  }, [agentSections]);

  useEffect(() => {
    if (lastItem?.type === "error" && lastItem.item.stopReason === "auth_required" && agentId) {
      setAuthRequired(effectiveAuthKey, agentId, connection, lastUserMessage?.content ?? null);
    }
  }, [lastItem, effectiveAuthKey, agentId, connection, lastUserMessage, setAuthRequired]);

  useEffect(() => {
    const unlisten = listen<{ terminal_id: string; output: string }>(
      `acp://terminal-output/${sessionKey}`,
      (event) => {
        liveDispatch({
          type: "terminal_output",
          terminalId: event.payload.terminal_id,
          output: event.payload.output,
        });
        const isAuth = event.payload.terminal_id.startsWith("auth-terminal-");
        openAcpTerminalTab(event.payload.terminal_id, { isAuthTerminal: isAuth });
      },
    ).catch(console.error);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, [sessionKey, liveDispatch, openAcpTerminalTab]);

  useEffect(() => {
    const unlisten = listen<string>(`acp://session-error/${sessionKey}`, (e) => {
      if (e.payload === "auth_required" && agentId) {
        setAuthRequired(effectiveAuthKey, agentId, connection, null);
        setHasPreSpawnAuthError(true);
      }
    }).catch(console.error);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, [sessionKey, agentId, connection, effectiveAuthKey, setAuthRequired]);

  // Detect when auth terminal tab is closed before PTY exits.
  useEffect(() => {
    const entry = authRequiredTasks[effectiveAuthKey];
    if (!entry?.terminalId || entry.terminalState !== "running") return;
    if (!tabs.some((t) => t.acpTerminalId === entry.terminalId)) {
      setAuthTerminalInterrupted(effectiveAuthKey);
    }
  }, [tabs, effectiveAuthKey, authRequiredTasks, setAuthTerminalInterrupted]);

  // Not wrapped in useMemo: the result is a string compared by value, and the compiler
  // could not preserve the manual memo anyway — it memoizes this itself.
  let lastAgentSectionId: string | null = null;
  for (let i = agentSections.length - 1; i >= 0; i--) {
    const s = agentSections[i];
    if (s.type === "agentSection") {
      lastAgentSectionId = getItemKey(s.items[0]);
      break;
    }
  }

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

  const hasInterruptedCalls = useMemo(
    () => [...liveState.toolCallMap.values()].some((tc) => tc.status === "interrupted"),
    [liveState.toolCallMap],
  );
  const autoResumedRef = useRef(false);
  useEffect(() => {
    if (
      !liveState.isInitializing &&
      !isNewSession &&
      hasInterruptedCalls &&
      taskId != null &&
      !autoResumedRef.current
    ) {
      autoResumedRef.current = true;
      handleSend("resume");
    }
  }, [liveState.isInitializing, hasInterruptedCalls, isNewSession, taskId, handleSend]);

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

  const streamContent = liveState.isInitializing ? (
    <AgentLoadingSkeleton isNewSession={isNewSession} />
  ) : (
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
          {/* `data-compose-bounds`: this box clips, and both ComposeBar variants are positioned
              against it, so it is what the composer sizes its growth to. */}
          <div className="flex-1 relative min-h-0 overflow-hidden" data-compose-bounds>
            {/*
              Only the selected session's conversation is rendered. AgentMonitor keeps a panel
              mounted for every ACP session so its listeners and reducer state survive
              navigation, which means without this gate every session's full message tree —
              rendered Markdown, Shiki, KaTeX, Mermaid — sits in the DOM at once.

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
                canvasMap={liveState.canvasMap}
                onOpenPlanOverlay={handleOpenPlanOverlay}
                onOpenFile={handleOpenFile}
                inlinePermission={inlinePermission}
                bottomPadding={composeBarHeight}
                commands={availableCommands}
                onAuthLogin={
                  hasAuthError || hasPreSpawnAuthError ? () => setIsAuthModalOpen(true) : undefined
                }
              />
            )}
            <AgentBottomBar
              isSessionDead={isSessionDead}
              showCompose={showCompose}
              composeBarWrapperRef={composeBarWrapperRef}
              composeBarRef={composeBarRef}
              {...sharedComposeBarProps}
            />
            <AgentScrollOverlays
              userMessages={userMessages}
              orderedSectionIds={orderedSectionIds}
              isSelected={isSelected}
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
      {agentId && (
        <AgentAuthModal
          agentId={agentId}
          agentName={agentId}
          connection={connection}
          taskId={effectiveAuthKey}
          sessionKey={sessionKey}
          terminalState={authRequiredTasks[effectiveAuthKey]?.terminalState ?? "idle"}
          open={isAuthModalOpen}
          onAuthSuccess={() => {
            setIsAuthModalOpen(false);
            setHasPreSpawnAuthError(false);
            clearAuthRequired(effectiveAuthKey);
            if (lastUserMessage) {
              void handleSend(lastUserMessage.content);
            } else if (taskId === null) {
              setPendingSessionRetry({ sessionKey, lastPrompt: null });
            }
          }}
          onRetry={() => {
            const entry = authRequiredTasks[effectiveAuthKey];
            if (entry?.terminalId) void commands.acpAbortAuthTerminal(connection);
            setAuthTerminalIdle(effectiveAuthKey);
          }}
          onClose={() => setIsAuthModalOpen(false)}
        />
      )}
      <ResizablePanelGroup
        orientation="horizontal"
        elementRef={groupElementRef}
        disabled={maximized}
        className="relative flex-1 min-h-0 overflow-hidden"
      >
        <ResizablePanel minSize="42rem" className="flex flex-col min-h-0 overflow-hidden bg-card">
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex flex-col flex-1 min-h-0 rounded-t-xl border-t border-l border-r border-border bg-background overflow-hidden">
              {headerSlot}
              {streamContent}
            </div>
          </div>
        </ResizablePanel>
        {/*
          Draggable but not drawn. It takes the panels' own background rather than
          `bg-transparent`, which would leave a 1px slot showing the view behind the
          group — a thin dark line, and a hook where the stream card's rounded corner
          curves away from it. Collapsed or maximized there is nothing to drag
          between, so it goes away entirely; `disabled` is what suppresses the drag
          target, since the library falls back to the panel edge when a separator is
          missing.
        */}
        <ResizableHandle
          disabled={sidePanelCollapsed || maximized}
          className={cn("bg-card hover:bg-card", (sidePanelCollapsed || maximized) && "hidden")}
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
          <ExecutionSidePanel
            fill
            sessionKey={sessionKey}
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={setActiveTabId}
            onTabClose={closeTab}
            onAddTab={addDynamicTab}
            onOpenTabKind={openTabKind}
            onOpenFile={handleOpenFile}
            workingFiles={localWorkingFiles}
            taskId={taskId}
            workspacePath={workspacePath}
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
            unseenTabIds={unseenTabIds}
            maximized={maximized}
            onMaximizedChange={handleMaximizedChange}
            onSpawnShell={onSpawnShell}
            isSessionActive={isSessionActive}
            terminalBuffers={liveState.terminalBuffers}
            onSendAnnotations={handleSendAnnotations}
            isProcessing={isProcessing}
            canSendImages={promptCapabilities?.image ?? false}
            onSeedPrompt={isSessionDead ? undefined : handleSeedPrompt}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
