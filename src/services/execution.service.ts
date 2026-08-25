import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { Channel as TAURI_CHANNEL } from "@tauri-apps/api/core";
import { taskQueryKeys } from "@/services/task.service";
import type { ConnectionKey } from "@/types/bindings";
import { commands } from "@/types/bindings";

export const executionQueryKeys = {
  activeSessions: (projectId: number) => ["activeSessions", projectId] as const,
  sessionList: (agentId: string, cwd: string, connection: ConnectionKey) =>
    ["sessionList", agentId, cwd, connection] as const,
  agentDiscovery: (connection: ConnectionKey) => ["agentDiscovery", connection] as const,
  projectAgents: (connection: ConnectionKey, cwd: string) =>
    ["projectAgents", connection, cwd] as const,
  sessionMeta: (sessionKey: number | null) => ["acpSessionMeta", sessionKey] as const,
  sessionFile: (sessionKey: number, relativePath: string, binary: boolean) =>
    ["sessionFile", sessionKey, relativePath, binary] as const,
  agentModels: (agentId: string, cwd: string, connection: ConnectionKey) =>
    ["agentModels", agentId, cwd, connection] as const,
};

export interface AgentModel {
  model_id: string;
  name: string;
}

/**
 * The models an agent offers, found by opening a session and closing it again.
 *
 * An agent only declares its models once a session exists — they arrive on the answer to
 * `session/new`, and nothing before that knows them. A settings page has no session by definition,
 * which is why the model was a free-text box you could typo into a spawn failure. So it makes one:
 * spawn, take the list off the event the reader already emits, close.
 *
 * `taskId` is null deliberately. `occupied_slots` counts sessions carrying a task id, so a probe
 * can never eat a capacity slot the board was holding for real work.
 *
 * Resolves to `[]` rather than throwing when the agent declares no models — plenty of agents have
 * exactly one and say nothing about it, and that is an answer, not a failure. The caller keeps its
 * stored value either way.
 */
async function probeAgentModels(
  agentId: string,
  cwd: string,
  projectId: number,
  connection: ConnectionKey,
): Promise<AgentModel[]> {
  const { log_id: logId } = await api.spawnAcpSession(
    agentId,
    cwd,
    null,
    projectId,
    connection,
    null,
    null,
    null,
  );

  try {
    return await new Promise<AgentModel[]>((resolve, reject) => {
      let models: AgentModel[] = [];
      let unlistenModels = () => {};
      let unlistenSpawnOk = () => {};
      let unlistenError = () => {};

      const finish = (run: () => void) => {
        clearTimeout(timer);
        unlistenModels();
        unlistenSpawnOk();
        unlistenError();
        run();
      };

      // An agent that never answers must not leave the panel spinning for ever. The session is
      // closed in `finally` regardless of which way this settles.
      const timer = setTimeout(() => finish(() => resolve(models)), 30_000);

      void listen<{ available_models: AgentModel[] }>(`acp://session-models/${logId}`, (event) => {
        models = event.payload.available_models;
      }).then((fn) => {
        unlistenModels = fn;
      });

      // Settled on spawn-ok, not on the models event: the reader emits the model state first and
      // spawn-ok after, so by here the list has arrived if the agent sends one at all. Waiting on
      // the models event alone would hang for every agent that declares none.
      void listen<null>(`acp://spawn-ok/${logId}`, () => finish(() => resolve(models))).then(
        (fn) => {
          unlistenSpawnOk = fn;
        },
      );

      void listen<string>(`acp://session-error/${logId}`, (event) =>
        finish(() => reject(new Error(event.payload))),
      ).then((fn) => {
        unlistenError = fn;
      });
    });
  } finally {
    await api.cancelAcpSession(logId).catch((err: unknown) => {
      console.warn("Failed to close model probe session:", err);
    });
  }
}

/**
 * Cached for five minutes, matching the agent-discovery window. Opening settings should cost one
 * probe per agent, not one per profile naming it, and not another on every re-render.
 */
export function useAgentModelsQuery(
  agentId: string | null,
  cwd: string | null,
  projectId: number | null,
  connection: ConnectionKey,
  enabled: boolean,
) {
  return useQuery({
    queryKey: executionQueryKeys.agentModels(agentId ?? "", cwd ?? "", connection),
    queryFn: () => probeAgentModels(agentId!, cwd!, projectId!, connection),
    enabled: enabled && !!agentId && !!cwd && projectId != null,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * Active session list. Refreshes on the "sessions-changed" Tauri event, plus a slow poll: a
 * checkout inside a session's directory changes the branch it reports and emits no event.
 */
export function useActiveSessionsQuery(projectId: number | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (projectId === undefined) return;
    let unlisten: (() => void) | undefined;
    listen("sessions-changed", () => {
      void queryClient.invalidateQueries({
        queryKey: executionQueryKeys.activeSessions(projectId),
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [queryClient, projectId]);

  return useQuery({
    queryKey:
      projectId !== undefined
        ? executionQueryKeys.activeSessions(projectId)
        : ["activeSessions-disabled"],
    queryFn: () => api.getActiveSessions(projectId!),
    enabled: projectId !== undefined,
    refetchInterval: 10000,
  });
}

/**
 * On-demand query for ACP session history from the agent.
 * Only fires when enabled=true (e.g. when history panel is open).
 * Returns { sessions, supports_session_delete } via SessionListResult.
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
 * Delete one or more sessions from an agent's session history.
 * Invalidates the session list query on success to refresh the panel.
 */
export function useDeleteAcpSessionMutation() {
  const queryClient = useQueryClient();
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
      return await api.deleteAcpSession(agentId, sessionId, cwd, connection);
    },
    onSuccess: (_data, { agentId, cwd, connection }) => {
      void queryClient.invalidateQueries({
        queryKey: executionQueryKeys.sessionList(agentId, cwd, connection),
      });
    },
    onError: createErrorToastHandler("Failed to delete session"),
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
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey:
          projectId != null ? executionQueryKeys.activeSessions(projectId) : ["activeSessions"],
      });
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
 * Spawn a user-controlled interactive shell on a branch.
 * Managed AI-agent sessions use ACP instead of this PTY path.
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
      branchName: string | null;
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
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: executionQueryKeys.activeSessions(projectId),
      });
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
export function useAgentDiscoveryQuery(connection: ConnectionKey, enabled: boolean = true) {
  return useQuery({
    queryKey: executionQueryKeys.agentDiscovery(connection),
    queryFn: () => api.discoverAgents(connection),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useSetToolPathMutation() {
  return useMutation({
    mutationFn: ({
      connection,
      tool,
      path,
    }: {
      connection: ConnectionKey;
      tool: string;
      path: string | null;
    }) => api.setToolPath(connection, tool, path),
    onError: createErrorToastHandler("Failed to update binary path"),
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
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: executionQueryKeys.activeSessions(projectId),
      });
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
    onSuccess: (_data, { agentId, projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: executionQueryKeys.activeSessions(projectId),
      });
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "sessionList" && query.queryKey[1] === agentId,
      });
    },
    onError: createErrorToastHandler("Failed to rename session"),
  });
}

/**
 * Lightweight query for ACP session metadata (cwd, project_id, session_start_sha).
 * Used to resolve relative file paths to absolute paths inside working file views.
 */
export function useAcpSessionMeta(sessionKey: number | null) {
  return useQuery({
    queryKey: executionQueryKeys.sessionMeta(sessionKey),
    queryFn: () => api.getAcpSessionMeta(sessionKey!),
    enabled: sessionKey != null,
  });
}

/**
 * Contents of a file inside a session's working directory.
 *
 * `refetchIntervalMs` polls it, because a file the agent is still writing changes with no
 * event to listen for. Pass `null` for the path to disable the query — the loading and
 * error states then come from the query itself rather than being mirrored into component
 * state around a bare `api` call.
 */
export function useSessionFileQuery(
  sessionKey: number,
  relativePath: string | null,
  binary: boolean,
  refetchIntervalMs?: number,
) {
  return useQuery({
    queryKey: executionQueryKeys.sessionFile(sessionKey, relativePath ?? "", binary),
    queryFn: () =>
      binary
        ? api.readSessionFileBinary(sessionKey, relativePath!)
        : api.readSessionFile(sessionKey, relativePath!),
    enabled: relativePath != null,
    refetchInterval: refetchIntervalMs ?? false,
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
      // projectId not available here; prefix match intentionally invalidates all projects.
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

export function useRecoverTaskSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, projectId }: { taskId: number; projectId: number }) => {
      const result = await commands.recoverTaskSession(taskId, projectId);
      if (result.status === "error") throw new Error(result.error);
      return result.data;
    },
    onSuccess: (_logId, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: executionQueryKeys.activeSessions(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to recover session"),
  });
}
