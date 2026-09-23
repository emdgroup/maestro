import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { useAcpActivity } from "../activity/useAcpActivity";
import { useAcpSessionLifecycle } from "../activity/useAcpSessionLifecycle";
import { useSelectedProject } from "@/store/projectStore";
import { ActivityPlanPanel } from "../activity/ActivityPlanPanel";
import type { ComposeBarHandle } from "../activity/compose-bar/ComposeBar";
import { PermissionPrompt, isPlanPermission, extractBodyText } from "../activity/PermissionPrompt";
import { PendingPlanCard } from "../activity/PlanReviewCard";
import {
  extractPlanToolCallId,
  extractBodyTextFromToolCallItem,
} from "../activity/permission-prompt-utils";
import { ElicitationPrompt, parseElicitationFields } from "../activity/ElicitationPrompt";
import { deriveTaskDraft } from "../activity/task-draft";
import type { TaskDraft } from "../activity/task-draft";
import { CreateTaskModal } from "@/components/kanban/create-task-modal/CreateTaskModal";
import { useNavigationStore } from "@/store/navigationStore";
import {
  groupToolCalls,
  groupIntoAgentSections,
  mergeLiveItems,
  isSubagentToolCall,
} from "../activity/utils";
import type { UsageState, ToolCallItem, UserMessageItem } from "../activity/types";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/utils";
import { fileUriToPath, toPosixPath } from "@/lib/path-utils";
import { useSessionActivity, useSessionActivityActions } from "@/store/sessionActivityStore";
import { useActiveTab } from "@/store/navigationStore";
import { useBoardActions, useBoardStore } from "@/store/boardStore";
import { commands } from "@/types/bindings";
import type { JsonValue, ConnectionKey } from "@/types/bindings";
import { ExecutionSidePanel } from "@/components/execution/side-panel/ExecutionSidePanel";
import { useSidePanelTabs } from "@/components/execution/side-panel/useSidePanelTabs";
import { useCanvasImport } from "@/components/execution/side-panel/useCanvasImport";
import { CanvasImportDialog } from "@/components/execution/side-panel/CanvasImportDialog";
import { buildAnnotationBlocks } from "@/components/execution/side-panel/annotations/build-annotation-prompt";
import {
  buildCanvasEventPrompt,
  buildCanvasRestoredPrompt,
} from "@/components/execution/activity/canvas/canvas-prompt";
import type { CanvasEvent } from "@/components/execution/activity/canvas/canvas-events";
import { awaitForSurface } from "@/components/execution/activity/canvas/await-matching";
import { useAnnotationStore } from "@/store/annotationStore";
import type { Annotation } from "@/store/annotationStore";
import { useSessionDiffStats } from "@/components/execution/side-panel/useSessionDiffStats";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/ui/resizable";

import { useActivityStatusManager } from "./useActivityStatusManager";
import { useSidePanelState } from "./useSidePanelState";
import { useWorkingFileTracker } from "./useWorkingFileTracker";
import { useAcpSessionMeta, useActiveSessionsQuery } from "@/services/execution.service";
import { usePermissionHandlers } from "./usePermissionHandlers";
import { useMessageSender } from "./useMessageSender";
import { useAutoResume } from "./useAutoResume";
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
  sessionId,
  markSeen,
  userMessageCount,
  lastAgentSectionId,
}: {
  isSelected: boolean;
  activeTab: string;
  activityStatus: string | undefined;
  activitySeen: boolean | undefined;
  sessionId: string;
  markSeen: (sessionId: string) => void;
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
      markSeen(sessionId);
    }
  }, [isSelected, activeTab, scrollable.end, activityStatus, activitySeen, sessionId, markSeen]);
  return null;
}

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
  const { markSeen, setActivity } = useSessionActivityActions();
  const {
    setAuthRequired,
    clearAuthRequired,
    setAuthTerminalInterrupted,
    setAuthTerminalIdle,
    setPendingSessionRetry,
  } = useBoardActions();
  const authRequiredTasks = useBoardStore((s) => s.authRequiredTasks);
  const activityInfo = useSessionActivity(sessionId);
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
  const canvasesRestoredRef = useRef<((surfaceIds: string[]) => void) | undefined>(undefined);

  const [liveState, liveDispatch] = useAcpActivity(
    sessionId,
    sessionUpdateRef,
    canvasesRestoredRef,
  );
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
    pendingCanvasAwaits,
  } = useAcpSessionLifecycle(sessionId, onUsageChangeRef, sessionUpdateRef);

  const [, setScrollRestoreToken] = useState(0);

  const pendingSendRef = useRef(false);
  // Panel-lived, so a stop suppresses auto-resume for the session. A remount (restart, reopen)
  // resets it and resumes — deliberate: a remount looks exactly like the restore case.
  const autoResumeSpentRef = useRef(false);
  useActivityStatusManager(
    sessionId,
    liveState,
    pendingSendRef,
    !!pendingPermission || !!pendingElicitation,
  );
  const { workingFiles: localWorkingFiles } = useWorkingFileTracker(sessionId, liveState.items);

  const { data: activeSessions } = useActiveSessionsQuery(selectedProject?.id);
  const taskId = useMemo(() => {
    const info = activeSessions?.find((s) => s.session_id === sessionId);
    return info?.task_id ?? null;
  }, [activeSessions, sessionId]);

  const isSessionActive = isSelected && activeTab === "agents";

  // The session's own working directory, not the project root: an isolated task runs in
  // `<project>/.maestro/worktrees/<name>`, and rooting the file tree at the project instead
  // hid every file the agent actually touched behind a dot-directory the listing prunes.
  // Shares its fetch with `useSessionDiffStats` below. One value feeds both the panel and
  // `handleOpenFile` so the relative paths handed over always match the tree's root.
  const { data: sessionMeta } = useAcpSessionMeta(sessionId);
  const workspacePath = sessionMeta?.cwd ?? selectedProject?.path ?? "";

  // Shares its fetch with SidePanelContent's identical call; read here so the Review tab can
  // open itself when the session's first change lands.
  const { changedFilesCount } = useSessionDiffStats(sessionId, isSessionActive);

  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [hasPreSpawnAuthError, setHasPreSpawnAuthError] = useState(false);

  const effectiveAuthKey = taskId == null ? sessionId : String(taskId);

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

  // Same shape, for the same reason: `useMessageSender` polls this from a callback while waiting
  // out a cancelled turn, and a value captured in a closure would never change.
  const isTurnActiveRef = useRef(liveState.isTurnActive);
  useEffect(() => {
    isTurnActiveRef.current = liveState.isTurnActive;
  }, [liveState.isTurnActive]);

  // Same again: `handleSend` reads this to decide whether a "busy" agent is busy working or just
  // parked on a canvas, and it must see the list as it is when the user presses enter.
  const pendingCanvasAwaitsRef = useRef(pendingCanvasAwaits);
  useEffect(() => {
    pendingCanvasAwaitsRef.current = pendingCanvasAwaits;
  }, [pendingCanvasAwaits]);

  const displayItems = useMemo(
    () => mergeLiveItems(liveState.items, livePermissionResponses, liveElicitationSummaries),
    [liveState.items, livePermissionResponses, liveElicitationSummaries],
  );
  const groupedItems = useMemo(() => groupToolCalls(displayItems), [displayItems]);
  const agentSections = useMemo(() => groupIntoAgentSections(groupedItems), [groupedItems]);

  /*
    Four consumers wanted four different views of the same list, and each used to walk it
    separately. One pass, since they all key off the same "is this a standalone user message"
    test — a readability win rather than a speed one; the memo already meant none of the four
    re-ran unless the sections changed.
  */
  const { userMessages, orderedSectionIds, userMessageCount } = useMemo(() => {
    const msgs: UserMessageItem[] = [];
    const ids: string[] = [];
    let standalones = 0;
    for (const section of agentSections) {
      if (section.type === "standalone") {
        standalones++;
        const gi = section.item;
        if (gi.type === "solo" && gi.item.type === "userMessage") {
          msgs.push(gi.item.item);
          ids.push(gi.item.item.id);
        }
      } else {
        ids.push(getItemKey(section.items[0]));
      }
    }
    return { userMessages: msgs, orderedSectionIds: ids, userMessageCount: standalones };
  }, [agentSections]);
  const lastUserMessage = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
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
    autoResumeSpentRef,
    isTurnActiveRef,
    pendingCanvasAwaitsRef,
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
      await api.setAcpConfigOption(sessionId, optionId, value).catch(() => {
        toast.error("Failed to save config option");
      });
    },
    [sessionId],
  );

  // Stable so the stream's memoized rows can bail out: an inline arrow here would be a new prop
  // on every render of this panel, which is every chunk.
  const handleAuthLogin = useCallback(() => setIsAuthModalOpen(true), []);

  const handleOpenPlanOverlay = useCallback(() => {
    handleOpenPlanOverlaySplit();
    openTabKind("plan");
  }, [handleOpenPlanOverlaySplit, openTabKind]);

  // A canvas the agent is waiting on is a request, not a notification: put it on screen rather
  // than raising an unseen dot on a collapsed panel. Keyed on the newest wait, so a second one
  // arriving re-opens the panel the user closed on the first.
  const awaitedRequestId = pendingCanvasAwaits[pendingCanvasAwaits.length - 1]?.requestId ?? null;
  useEffect(() => {
    if (!awaitedRequestId) return;
    openTabKind("canvas");
    setSidePanelCollapsed(false);
  }, [awaitedRequestId, openTabKind, setSidePanelCollapsed]);

  // A surface outlives the turn that drew it: restoring a session brings its canvases back while
  // the agent is idle, and an idle agent cannot have a `canvas_await` open because it cannot call
  // a tool outside a turn. So a control with no wait behind it sends its event as a prompt, which
  // starts one — after which the agent answers and re-arms, and everything that follows takes the
  // direct path above. Without this a restored canvas is a picture of a UI rather than a UI.
  const [queuedCanvasEvents, setQueuedCanvasEvents] = useState<CanvasEvent[]>([]);
  const handleCanvasEvent = useCallback(
    (requestId: string | null, event: unknown) => {
      if (requestId) {
        void api.respondHostTool(sessionId, requestId, event as JsonValue).catch(() => {
          toast.error("Could not send your answer to the agent");
        });
        setActivity(sessionId, "thinking");
        return;
      }
      // Mid-turn there is nowhere to put it: ACP allows one `session/prompt` per turn, and the
      // agent has not armed a wait. Queued rather than dropped — the gap between one
      // `canvas_await` returning and the next one arming is on every turn, and a click lost there
      // leaves the agent acting on a surface it can no longer see.
      if (isProcessing) {
        setQueuedCanvasEvents((queued) => [...queued, event as CanvasEvent]);
        return;
      }
      void handleSend(buildCanvasEventPrompt([event as CanvasEvent]));
    },
    [sessionId, setActivity, isProcessing, handleSend],
  );

  // Drains one event per pass: answering a wait consumes it, which brings the agent back here with
  // a new one, and the effect runs again for the next event. Only when no wait can take them and
  // the agent has gone idle do the rest travel together as a prompt.
  useEffect(() => {
    const [next, ...rest] = queuedCanvasEvents;
    if (!next || liveState.sessionEnded) return;
    const waiting = awaitForSurface(pendingCanvasAwaits, next.surfaceId);
    if (waiting) {
      setQueuedCanvasEvents(rest);
      void api
        .respondHostTool(sessionId, waiting.requestId, next as unknown as JsonValue)
        .catch(() => toast.error("Could not send your answer to the agent"));
      setActivity(sessionId, "thinking");
      return;
    }
    if (isProcessing) return;
    setQueuedCanvasEvents([]);
    void handleSend(buildCanvasEventPrompt(queuedCanvasEvents));
  }, [
    queuedCanvasEvents,
    pendingCanvasAwaits,
    isProcessing,
    liveState.sessionEnded,
    sessionId,
    setActivity,
    handleSend,
  ]);

  // An import happens whenever the user says so, which may be mid-turn — and ACP allows one
  // `session/prompt` per turn. Held until the agent is idle, then drained one at a time: sending
  // the first makes it busy again, so the next waits for that turn in its turn.
  const [queuedCanvasPrompts, setQueuedCanvasPrompts] = useState<string[]>([]);
  const queueCanvasPrompt = useCallback((text: string) => {
    setQueuedCanvasPrompts((queued) => [...queued, text]);
  }, []);
  useEffect(() => {
    const [next, ...rest] = queuedCanvasPrompts;
    if (!next || isProcessing || liveState.sessionEnded) return;
    setQueuedCanvasPrompts(rest);
    void handleSend(next);
  }, [queuedCanvasPrompts, isProcessing, liveState.sessionEnded, handleSend]);

  const canvasImport = useCanvasImport({
    sessionId: sessionId,
    canvasMap: liveState.canvasMap,
    onSurface: (surface) => liveDispatch({ type: "restore_canvases", surfaces: [surface] }),
    onCloseSurface: (surfaceId) => liveDispatch({ type: "close_canvas", surfaceId }),
    onPrompt: queueCanvasPrompt,
  });

  // One prompt however many canvases came back, and only to ask the agent to arm `canvas_await` —
  // after which every click is answered directly and costs nothing. `useAcpActivity` owns the
  // once-per-session part, which cannot live in this component: it remounts.
  useEffect(() => {
    canvasesRestoredRef.current = (surfaceIds: string[]) => {
      if (surfaceIds.length > 0) void handleSend(buildCanvasRestoredPrompt(surfaceIds));
    };
  }, [handleSend]);

  const [taskDraft, setTaskDraft] = useState<TaskDraft | null>(null);
  const handleCreateTaskFromText = useCallback((text: string) => {
    setTaskDraft(deriveTaskDraft(text));
  }, []);

  const handleOpenFile = useCallback(
    (uri: string) => {
      // Tool calls report Windows paths with backslashes and an arbitrarily cased
      // drive letter, so compare on a normalised copy — a missed prefix would send
      // an absolute path to a panel that resolves everything against the workspace.
      const abs = fileUriToPath(uri);
      const base = toPosixPath(workspacePath).replace(/\/+$/, "");
      const inWorkspace = base !== "" && abs.toLowerCase().startsWith(`${base.toLowerCase()}/`);
      addDynamicTab("files", inWorkspace ? abs.slice(base.length + 1) : abs);
      setSidePanelCollapsed(false);
    },
    [addDynamicTab, workspacePath, setSidePanelCollapsed],
  );

  useEffect(() => {
    if (lastItem?.type === "error" && lastItem.item.stopReason === "auth_required" && agentId) {
      setAuthRequired(effectiveAuthKey, agentId, connection, lastUserMessage?.content ?? null);
    }
  }, [lastItem, effectiveAuthKey, agentId, connection, lastUserMessage, setAuthRequired]);

  useEffect(() => {
    const unlisten = listen<{ terminal_id: string; output: string }>(
      `acp://terminal-output/${sessionId}`,
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
  }, [sessionId, liveDispatch, openAcpTerminalTab]);

  useEffect(() => {
    const unlisten = listen<string>(`acp://session-error/${sessionId}`, (e) => {
      if (e.payload === "auth_required" && agentId) {
        setAuthRequired(effectiveAuthKey, agentId, connection, null);
        setHasPreSpawnAuthError(true);
      }
    }).catch(console.error);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, [sessionId, agentId, connection, effectiveAuthKey, setAuthRequired]);

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
  // A plan review takes the composer's place the same way an inline permission does: the card in
  // the stream is the answer, and a prompt sent while the agent is blocked on the request has
  // nowhere to go — see the cancel-first sequence in `useMessageSender`.
  const hasPendingPlan = !!(pendingPermission && isPlanPermWithBody);

  const showCompose =
    !isSessionDead &&
    !elicitationContent &&
    !hasInlinePermission &&
    !hasPendingPlan &&
    !isCenteredCompose;

  const hasElicitation = !!elicitationContent;

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
    // The bar is also present when a request has replaced the composer, and that card is a
    // different height — the stream reserves room from this measurement, so it has to re-measure
    // when one takes the other's place.
  }, [showCompose, hasInlinePermission, hasPendingPlan, hasElicitation, liveState.isInitializing]);

  useAutoResume({
    toolCallMap: liveState.toolCallMap,
    isInitializing: liveState.isInitializing,
    isNewSession,
    taskId,
    autoResumeSpentRef,
    handleSend,
  });

  // The plan tool call the open request names, so its row can be left out of the stream and shown
  // in the slot below instead.
  const livePlanToolCallId =
    hasPendingPlan && pendingPermission ? extractPlanToolCallId(pendingPermission.payload) : null;

  // Whatever the agent is waiting on, in the composer's place — see `AgentBottomBar`. A plan and an
  // elicitation are one more thing it is asking for, so all three go here rather than into the
  // conversation they are about, where they would trail the last message with dead space beneath.
  const pendingRequestBody = isSessionDead ? null : elicitationContent ? (
    <ElicitationPrompt
      key={elicitationContent.requestId}
      requestId={elicitationContent.requestId}
      message={elicitationContent.message}
      fields={elicitationContent.fields}
      otherField={elicitationContent.otherField}
      onSubmit={handleElicitationSubmit}
      onDecline={handleElicitationDecline}
    />
  ) : hasPendingPlan && pendingPermission ? (
    <PendingPlanCard
      key={pendingPermission.requestId}
      sessionId={sessionId}
      modelId={configValues.model ?? null}
      title={
        (livePlanToolCallId ? liveState.toolCallMap.get(livePlanToolCallId)?.title : null) ?? null
      }
      requestId={pendingPermission.requestId}
      payload={pendingPermission.payload}
      onRespond={handlePlanRespond}
      onOpen={handleOpenPlanOverlay}
    />
  ) : hasInlinePermission && pendingPermission ? (
    <PermissionPrompt
      key={pendingPermission.requestId}
      requestId={pendingPermission.requestId}
      payload={pendingPermission.payload}
      onRespond={handlePermissionRespond}
    />
  ) : null;

  const pendingRequestCard = pendingRequestBody ? (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {pendingRequestBody}
    </motion.div>
  ) : null;

  const sharedComposeBarProps = {
    onSend: handleSendWithTransition as (content: string, contentBlocks?: JsonValue) => void,
    onCancel: handleCancel,
    isProcessing: isProcessing && pendingCanvasAwaits.length === 0,
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
                livePlanToolCallId={livePlanToolCallId}
                onOpenFile={handleOpenFile}
                bottomPadding={composeBarHeight}
                commands={availableCommands}
                projectId={selectedProject?.id}
                workspacePath={workspacePath}
                onAuthLogin={hasAuthError || hasPreSpawnAuthError ? handleAuthLogin : undefined}
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
    <div className="flex-1 flex flex-col min-h-0">
      <CanvasImportDialog request={canvasImport.request} onChoice={canvasImport.resolve} />
      {selectedProject && (
        <CreateTaskModal
          isOpen={!!taskDraft}
          onClose={() => setTaskDraft(null)}
          projectId={selectedProject.id}
          initial={taskDraft ?? undefined}
          onCreated={(task) => {
            toast.success(`Task created: ${task.title}`, {
              action: {
                label: "Open",
                onClick: () => {
                  useNavigationStore.getState().setActiveTab("kanban");
                  useNavigationStore.getState().setActiveTaskId(task.id);
                },
              },
            });
          }}
        />
      )}
      {agentId && (
        <AgentAuthModal
          agentId={agentId}
          agentName={agentId}
          connection={connection}
          authKey={effectiveAuthKey}
          sessionId={sessionId}
          terminalState={authRequiredTasks[effectiveAuthKey]?.terminalState ?? "idle"}
          open={isAuthModalOpen}
          onAuthSuccess={() => {
            setIsAuthModalOpen(false);
            setHasPreSpawnAuthError(false);
            clearAuthRequired(effectiveAuthKey);
            if (lastUserMessage) {
              void handleSend(lastUserMessage.content);
            } else if (taskId === null) {
              setPendingSessionRetry({ sessionId, lastPrompt: null });
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
            sessionId={sessionId}
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
            pendingCanvasAwaits={pendingCanvasAwaits}
            onCanvasEvent={handleCanvasEvent}
            onCloseCanvas={(surfaceId) => liveDispatch({ type: "close_canvas", surfaceId })}
            onImportCanvas={canvasImport.importFile}
            subagentItems={subagentItems}
            toolCallMap={liveState.toolCallMap}
            sidePanelPlan={sidePanelPlan}
            planEntries={liveState.plan}
            planTitle={liveState.planTitle}
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
