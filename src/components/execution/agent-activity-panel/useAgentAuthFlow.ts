import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ActiveSessionInfo, ConnectionKey } from "@/types/bindings";
import { connectionChannelId } from "@/lib/connection-utils";
import { useAuthRequiredTask, useBoardActions, useBoardStore } from "@/store/boardStore";
import { authQueryKeys } from "@/services/acp-auth.service";
import { useTauriEvent } from "@/services/tauri-events";
import type { ActivityItem, UserMessageItem } from "../activity/types";

/**
 * A session's side of signing its agent in: noticing that the agent asked for it, offering the
 * sign-in, noticing when the sign-in terminal's tab is closed before it finished, and picking the
 * conversation up again afterwards.
 *
 * The sign-in state lives in the board store under `authKey`, the task's id for a task's session
 * and the session's own id otherwise, so a task card and this panel share one entry.
 */
export function useAgentAuthFlow({
  sessionId,
  agentId,
  connection,
  taskId,
  items,
  lastUserMessage,
  terminalIds,
  resend,
}: {
  sessionId: string;
  agentId: string | null;
  connection: ConnectionKey;
  taskId: number | null;
  items: ActivityItem[];
  lastUserMessage: UserMessageItem | null;
  /** The ACP terminals the side panel has a tab for. */
  terminalIds: readonly (string | undefined)[];
  /** Sends the prompt the agent refused, once it is signed in. */
  resend: (content: string) => void;
}) {
  const { setAuthRequired, clearAuthRequired, setAuthTerminalInterrupted, setPendingSessionRetry } =
    useBoardActions();
  const authKey = taskId == null ? sessionId : String(taskId);
  const entry = useAuthRequiredTask(authKey);
  const [modalOpen, setModalOpen] = useState(false);
  // The spawn itself was refused, so there is no stream item to say so.
  const [refusedAtSpawn, setRefusedAtSpawn] = useState(false);

  const lastItem = items[items.length - 1];
  const refusedInStream = items.some(
    (item) => item.type === "error" && item.item.stopReason === "auth_required",
  );

  useEffect(() => {
    if (lastItem?.type === "error" && lastItem.item.stopReason === "auth_required" && agentId) {
      setAuthRequired(authKey, agentId, connection, lastUserMessage?.content ?? null);
    }
  }, [lastItem, authKey, agentId, connection, lastUserMessage, setAuthRequired]);

  useTauriEvent<string>(`acp://session-error/${sessionId}`, (payload) => {
    if (payload === "auth_required" && agentId) {
      setAuthRequired(authKey, agentId, connection, null);
      setRefusedAtSpawn(true);
    }
  });

  // The sign-in terminal's tab was closed before its process exited.
  useEffect(() => {
    if (!entry?.terminalId || entry.terminalState !== "running") return;
    if (!terminalIds.includes(entry.terminalId)) setAuthTerminalInterrupted(authKey);
  }, [terminalIds, authKey, entry, setAuthTerminalInterrupted]);

  // Stable so the stream's memoized rows can bail out: an inline arrow would be a new prop on
  // every render of the panel, which is every chunk.
  const openSignIn = useCallback(() => setModalOpen(true), []);

  function onAuthSuccess() {
    setModalOpen(false);
    setRefusedAtSpawn(false);
    clearAuthRequired(authKey);
    if (lastUserMessage) {
      resend(lastUserMessage.content);
    } else if (taskId === null) {
      setPendingSessionRetry({ sessionId, lastPrompt: null });
    }
  }

  return {
    authKey,
    /** Offered from the stream only once the agent has refused. */
    openSignIn: refusedInStream || refusedAtSpawn ? openSignIn : undefined,
    modal: { open: modalOpen, onClose: () => setModalOpen(false), onAuthSuccess },
  };
}

/**
 * A connection's side of signing agents in, mounted once per connection by the agents view: a
 * sign-in terminal exiting, which either finishes the sign-in and queues the retry or puts the
 * methods back on offer, and an agent's sign-in state changing, which refreshes what is offered.
 */
export function useConnectionAuthEvents(connection: ConnectionKey, sessions: ActiveSessionInfo[]) {
  const queryClient = useQueryClient();
  const { clearAuthRequired, setAuthTerminalIdle, setPendingAuthRetry, setPendingSessionRetry } =
    useBoardActions();
  const connId = connectionChannelId(connection);

  useTauriEvent<{ exit_code: number | null }>(`acp://auth-pty-exit/${connId}`, (payload) => {
    const tasks = useBoardStore.getState().authRequiredTasks;
    const found = Object.entries(tasks).find(
      ([, e]) => e.terminalState === "running" && connectionChannelId(e.connection) === connId,
    );
    if (!found) return;
    // A task's entry is keyed by its task id, a manual session's by its session id.
    const [authKey, entry] = found;
    if (payload.exit_code !== 0) {
      setAuthTerminalIdle(authKey);
      return;
    }
    clearAuthRequired(authKey);
    if (sessions.some((s) => s.session_id === authKey && !s.task_id)) {
      setPendingSessionRetry({ sessionId: authKey, lastPrompt: entry.lastPrompt ?? null });
    } else {
      setPendingAuthRetry(Number(authKey));
    }
  });

  useTauriEvent<{ agentId: string }>(`acp://auth-state-changed/${connId}`, (payload) => {
    void queryClient.invalidateQueries({
      queryKey: authQueryKeys.info(payload.agentId, connection),
    });
  });
}
