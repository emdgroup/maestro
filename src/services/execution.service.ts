import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { Channel as TAURI_CHANNEL } from "@tauri-apps/api/core";
import { taskQueryKeys } from "@/services/task.service";
import type { ConnectionKey } from "@/types/bindings";
import { connectionKeysEqual } from "@/lib/connection-utils";

export const executionQueryKeys = {
  activeSessions: (projectId: number) => ["activeSessions", projectId] as const,
  sessionList: (agentId: string, cwd: string, connection: ConnectionKey) =>
    ["sessionList", agentId, cwd, connection] as const,
  agentDiscovery: (connection: ConnectionKey) => ["agentDiscovery", connection] as const,
  projectAgents: (connection: ConnectionKey, cwd: string) =>
    ["projectAgents", connection, cwd] as const,
};

/**
 * Event-driven active session list. Refreshes on "sessions-changed" Tauri event.
 * No polling — sidebar stays in sync without DB queries.
 */
export function useActiveSessionsQuery(projectId: number | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (projectId === undefined) return;
    let unlisten: (() => void) | undefined;
    listen("sessions-changed", () => {
      void queryClient.invalidateQueries({ queryKey: executionQueryKeys.activeSessions(projectId) });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient, projectId]);

  return useQuery({
    queryKey: projectId !== undefined ? executionQueryKeys.activeSessions(projectId) : ["activeSessions-disabled"],
    queryFn: () => api.getActiveSessions(projectId!),
    enabled: projectId !== undefined,
  });
}

/**
 * On-demand query for ACP session history from the agent.
 * Only fires when enabled=true (e.g. when history panel is open).
 */
export function useSessionListQuery(
  agentId: string | null,
  cwd: string | null,
  connection: ConnectionKey,
  projectId: number | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: executionQueryKeys.sessionList(agentId ?? "", cwd ?? "", connection),
    queryFn: () => api.listAcpSessions(projectId!, agentId!, cwd!, connection, null),
    enabled: enabled && agentId != null && cwd != null && projectId != null,
    staleTime: 30_000,
  });
}

/**
 * Load a stored ACP session, creating a new active session that replays history.
 */
export function useLoadAcpSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      sessionId,
      cwd,
      connection,
      sessionName,
      projectId,
      worktreeBranch,
    }: {
      agentId: string;
      sessionId: string;
      cwd: string;
      connection: ConnectionKey;
      sessionName?: string | null;
      projectId?: number | null;
      worktreeBranch?: string | null;
    }) => {
      return await api.loadAcpSession(
        agentId,
        sessionId,
        cwd,
        connection,
        sessionName ?? null,
        projectId ?? null,
        worktreeBranch ?? null,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["activeSessions"] });
    },
    onError: createErrorToastHandler("Failed to load session"),
  });
}

/**
 * Close a stored ACP session on the agent server (frees agent resources).
 */
export function useCloseStoredAcpSessionMutation() {
  return useMutation({
    mutationFn: async ({
      agentId,
      sessionId,
      cwd,
      connection,
    }: {
      agentId: string;
      sessionId: string;
      cwd: string;
      connection: ConnectionKey;
    }) => {
      return await api.closeAcpSession(agentId, sessionId, cwd, connection);
    },
    onError: createErrorToastHandler("Failed to close session"),
  });
}

/**
 * Mutation hook for spawning an interactive (task-free) PTY session on a branch.
 * Returns the session_key for attach_terminal.
 */
export function useSpawnInteractiveExecutionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      branchName,
      repoPath,
      sessionName,
      worktreeId,
      taskId,
      taskDescription,
    }: {
      projectId: number;
      branchName: string;
      repoPath: string;
      sessionName: string | null;
      worktreeId?: number | null;
      taskId?: number | null;
      taskDescription?: string | null;
    }) => {
      return await api.spawnInteractiveExecution(
        projectId,
        branchName,
        repoPath,
        sessionName,
        worktreeId ?? null,
        taskId ?? null,
        taskDescription ?? null,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["activeSessions"] });
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to spawn interactive session"),
  });
}

/**
 * Detect which agent tools have config markers in the given project directory.
 * Used to suggest or pre-select a default agent when opening a project.
 * Requires preflight to have run for this connection.
 */
export function useProjectAgentsQuery(
  connection: ConnectionKey,
  cwd: string | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: executionQueryKeys.projectAgents(connection, cwd ?? ""),
    queryFn: () => api.detectProjectAgents(connection, cwd!),
    enabled: enabled && cwd != null,
    staleTime: 60_000,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Unified agent discovery hook — works for both local and remote connections.
 * 5-minute staleTime mirrors backend TTL.
 */
export function useAgentDiscoveryQuery(
  connection: ConnectionKey,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: executionQueryKeys.agentDiscovery(connection),
    queryFn: () => api.discoverAgents(connection),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

/** Full agent catalog (config options, commands, capabilities) from AgentCache. Available after first SpawnOk/PreInitialize. */
export function useAgentCacheQuery(
  agentId: string | null,
  connection: ConnectionKey,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ConnectionKey & { agent_id: string }>(
      "agent-cache-updated",
      (event) => {
        if (
          event.payload.agent_id === agentId &&
          connectionKeysEqual(event.payload, connection)
        ) {
          void queryClient.invalidateQueries({
            queryKey: ["agentCache", connection, agentId],
          });
        }
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient, agentId, connection]);

  return useQuery({
    queryKey: ["agentCache", connection, agentId] as const,
    queryFn: () => api.getAgentCache(agentId!, connection),
    enabled: agentId != null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * Mutation hook for spawning an ACP session for a given agent and worktree path.
 */
export function useSpawnAcpSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      cwd,
      sessionName,
      projectId,
      connection,
      worktreeBranch,
      taskId,
      taskName,
    }: {
      agentId: string;
      cwd: string;
      sessionName: string | null;
      projectId: number;
      connection: ConnectionKey;
      worktreeBranch?: string | null;
      taskId?: number | null;
      taskName?: string | null;
    }) => {
      return await api.spawnAcpSession(
        agentId,
        cwd,
        sessionName,
        projectId,
        connection,
        worktreeBranch ?? null,
        taskId ?? null,
        taskName ?? null,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["activeSessions"] });
    },
    onError: createErrorToastHandler("Failed to spawn ACP session"),
  });
}

/**
 * Rename an ACP session — stores a user-defined display name in the local DB.
 * Overlays agent-provided title in the history list.
 */
export function useRenameAcpSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      agentId,
      acpSessionId,
      displayName,
    }: {
      projectId: number;
      agentId: string;
      acpSessionId: string;
      displayName: string;
    }) => {
      return await api.renameAcpSession(projectId, agentId, acpSessionId, displayName);
    },
    onSuccess: (_data, { agentId }) => {
      void queryClient.invalidateQueries({ queryKey: ["activeSessions"] });
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "sessionList" && query.queryKey[1] === agentId,
      });
    },
    onError: createErrorToastHandler("Failed to rename session"),
  });
}

/**
 * Flush buffered replay events for a loaded session.
 * Called after event listeners are registered to avoid the subscribe/emit race.
 */
export async function drainAcpReplay(logId: number): Promise<void> {
  await api.drainAcpReplay(logId);
}

/**
 * Cancel/close an active session. ACP sessions receive a CancelRequest; PTY sessions are fully killed and removed.
 */
export function useCancelActiveSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionKey,
      executionMode,
    }: {
      sessionKey: number;
      executionMode: string;
    }) => {
      if (executionMode === "acp") {
        return await api.cancelAcpSession(sessionKey);
      } else {
        return await api.closePtySession(sessionKey);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["activeSessions"] });
    },
    onError: createErrorToastHandler("Failed to close session"),
  });
}

export function useAttachTerminalMutation() {
  return useMutation({
    mutationFn: async ({
      taskId,
      outputChannel,
    }: {
      taskId: number;
      outputChannel: TAURI_CHANNEL<string>;
    }) => {
      return await api.attachTerminal(taskId, outputChannel, null);
    },
    onError: createErrorToastHandler("Failed to attach terminal"),
  });
}

export function useDetachTerminalMutation() {
  return useMutation({
    mutationFn: async ({ taskId }: { taskId: number }) => {
      return await api.detachTerminal(taskId);
    },
    onError: createErrorToastHandler("Failed to detach terminal"),
  });
}

export function useSendTerminalInputMutation() {
  return useMutation({
    mutationFn: async ({ taskId, input }: { taskId: number; input: string }) => {
      return await api.sendTerminalInput(taskId, input);
    },
    onError: createErrorToastHandler("Failed to send terminal input"),
  });
}

export function useResizeTerminalMutation() {
  return useMutation({
    mutationFn: async ({ taskId, cols, rows }: { taskId: number; cols: number; rows: number }) => {
      return await api.resizeTerminal(taskId, cols, rows);
    },
    onError: createErrorToastHandler("Failed to resize terminal"),
  });
}
