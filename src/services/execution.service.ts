import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib";
import { toast } from "sonner";
import { Channel as TAURI_CHANNEL } from "@tauri-apps/api/core";

export const executionQueryKeys = {
  activeSessions: ["activeSessions"] as const,
  sessionList: (agentId: string, cwd: string, connectionId: number | null) =>
    ["sessionList", agentId, cwd, connectionId] as const,
  agentModelsCache: (projectId: number, agentId: string) =>
    ["agentModelsCache", projectId, agentId] as const,
};

/**
 * Event-driven active session list. Refreshes on "sessions-changed" Tauri event.
 * No polling — sidebar stays in sync without DB queries.
 */
export function useActiveSessionsQuery() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("sessions-changed", () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.activeSessions });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient]);

  return useQuery({
    queryKey: executionQueryKeys.activeSessions,
    queryFn: () => api.getActiveSessions(),
  });
}

/**
 * On-demand query for ACP session history from the agent.
 * Only fires when enabled=true (e.g. when history panel is open).
 */
export function useSessionListQuery(
  agentId: string | null,
  cwd: string | null,
  connectionId: number | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: executionQueryKeys.sessionList(agentId ?? "", cwd ?? "", connectionId),
    queryFn: () => api.listAcpSessions(agentId!, cwd!, connectionId, null),
    enabled: enabled && agentId != null && cwd != null,
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
      connectionId,
      sessionName,
    }: {
      agentId: string;
      sessionId: string;
      cwd: string;
      connectionId: number | null;
      sessionName?: string | null;
    }) => {
      return await api.loadAcpSession(agentId, sessionId, cwd, connectionId, sessionName ?? null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.activeSessions });
    },
    onError: (error) => {
      toast.error(`Failed to load session: ${error}`);
    },
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
      connectionId,
    }: {
      agentId: string;
      sessionId: string;
      cwd: string;
      connectionId: number | null;
    }) => {
      return await api.closeAcpSession(agentId, sessionId, cwd, connectionId);
    },
    onError: (error) => {
      toast.error(`Failed to close session: ${error}`);
    },
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
        projectId, branchName, repoPath, sessionName,
        worktreeId ?? null, taskId ?? null, taskDescription ?? null
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.activeSessions });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => {
      toast.error(`Failed to spawn interactive session: ${error}`);
    },
  });
}

/**
 * Unified agent discovery hook — works for both local and remote connections.
 * connectionId = null → local maestro-server
 * connectionId = number → remote SSH connection
 * 5-minute staleTime mirrors backend TTL.
 */
export function useAgentDiscoveryQuery(
  connectionId: number | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ["agentDiscovery", connectionId],
    queryFn: () => api.discoverAgents(connectionId),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

/** Cached model list for an agent in a given project (.maestro/agent_models_cache.json). */
export function useAgentModelsCacheQuery(projectId: number, agentId: string | null) {
  return useQuery({
    queryKey: executionQueryKeys.agentModelsCache(projectId, agentId ?? ""),
    queryFn: () => api.getAgentModelsCache(projectId, agentId!),
    enabled: agentId != null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** Spawn a one-shot probe session to fetch and cache models for an agent. */
export function useRefreshAgentModelsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, agentId }: { projectId: number; agentId: string }) =>
      api.refreshAgentModels(projectId, agentId),
    onSuccess: (data, { projectId, agentId }) => {
      queryClient.setQueryData(executionQueryKeys.agentModelsCache(projectId, agentId), data);
    },
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
      connectionId,
      worktreeBranch,
    }: {
      agentId: string;
      cwd: string;
      sessionName: string | null;
      projectId: number;
      connectionId: number | null;
      worktreeBranch?: string | null;
    }) => {
      return await api.spawnAcpSession(agentId, cwd, sessionName, projectId, connectionId, worktreeBranch ?? null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.activeSessions });
    },
    onError: (error) => {
      toast.error(`Failed to spawn ACP session: ${error}`);
    },
  });
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
      queryClient.invalidateQueries({ queryKey: executionQueryKeys.activeSessions });
    },
    onError: (error) => {
      toast.error(`Failed to close session: ${error}`);
    },
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
    onError: (error) => {
      toast.error(`Failed to attach terminal: ${error}`);
    },
  });
}

export function useDetachTerminalMutation() {
  return useMutation({
    mutationFn: async ({ taskId }: { taskId: number }) => {
      return await api.detachTerminal(taskId);
    },
    onError: (error) => {
      toast.error(`Failed to detach terminal: ${error}`);
    },
  });
}

export function useSendTerminalInputMutation() {
  return useMutation({
    mutationFn: async ({ taskId, input }: { taskId: number; input: string }) => {
      return await api.sendTerminalInput(taskId, input);
    },
    onError: (error) => {
      toast.error(`Failed to send terminal input: ${error}`);
    },
  });
}

export function useResizeTerminalMutation() {
  return useMutation({
    mutationFn: async ({ taskId, cols, rows }: { taskId: number; cols: number; rows: number }) => {
      return await api.resizeTerminal(taskId, cols, rows);
    },
    onError: (error) => {
      toast.error(`Failed to resize terminal: ${error}`);
    },
  });
}
