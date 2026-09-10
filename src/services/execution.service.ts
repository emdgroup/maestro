import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import { Channel as TAURI_CHANNEL } from "@tauri-apps/api/core";
import { taskQueryKeys } from "@/services/task.service";
import { findEffortOption } from "@/lib/effort-option";
import type { ConfigOption } from "@/components/execution/activity/types";
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
  // `modelId` is part of the key because the effort list is a property of the model, not the
  // agent: the same harness offers different reasoning budgets per model, so a probe answered
  // against the agent's default model is the wrong answer for a profile naming another one.
  agentConfig: (agentId: string, cwd: string, connection: ConnectionKey, modelId: string) =>
    ["agentConfig", agentId, cwd, connection, modelId] as const,
};

export interface AgentModel {
  model_id: string;
  name: string;
}

export interface AgentMode {
  mode_id: string;
  name: string;
}

export interface AgentEffort {
  /** The agent's own config id, which is what `set_acp_config_option` addresses — not the category. */
  option_id: string;
  values: Array<{ value: string; name: string }>;
}

/**
 * What one probe of an agent comes back with.
 *
 * All three are properties of a session, arrive on the answer to the same `session/new`, and are
 * wanted by the same caller — so they are one query rather than three. Splitting them would spawn
 * the agent three times to read three fields of one response.
 */
export interface AgentConfig {
  models: AgentModel[];
  modes: AgentMode[];
  /** `null` when the agent exposes no effort setting, which most do not — it is not ACP-universal. */
  effort: AgentEffort | null;
}

/**
 * The models, permission modes and effort levels an agent offers, found by opening a session and
 * closing it again.
 *
 * An agent only declares them once a session exists — they all arrive on the answer to
 * `session/new`, and nothing before that knows them. A settings page has no session by definition,
 * which is why these were free-text boxes you could typo into a spawn failure. So it makes one:
 * spawn, take the lists off the events the reader already emits, close.
 *
 * `taskId` is null deliberately. `occupied_slots` counts sessions carrying a task id, so a probe
 * can never eat a capacity slot the board was holding for real work.
 *
 * Resolves with whatever arrived rather than throwing when a list is missing — plenty of agents
 * have exactly one model, or a single fixed permission mode, and say nothing about it. That is an
 * answer, not a failure.
 *
 * `modelId` is what makes the effort list right. Effort is per-model — the same harness offers
 * different budgets for different models — and a session starts on the agent's default, so a probe
 * that never switches reports the default model's list for every profile. When the caller names a
 * model that is not already current, the probe sets it and waits for the refreshed option set the
 * protocol sends back with the acknowledgement.
 */
async function probeAgentConfig(
  agentId: string,
  cwd: string,
  projectId: number,
  connection: ConnectionKey,
  modelId: string | null,
): Promise<AgentConfig> {
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
    return await new Promise<AgentConfig>((resolve, reject) => {
      const config: AgentConfig = { models: [], modes: [], effort: null };
      // The model the session actually opened on, so a caller asking for that one does not pay for
      // a round trip to set what is already set.
      let currentModelId: string | null = null;
      // Past spawn-ok the models and modes are already in hand, so nothing after it is worth
      // failing the whole probe over — a model the account lacks is one absent effort list, not an
      // unreachable agent.
      let spawned = false;
      // Set once the model switch is in flight: the next config-state-updated is its answer.
      let awaitingModel = false;
      let unlistenModels = () => {};
      let unlistenModes = () => {};
      let unlistenConfigOptions = () => {};
      let unlistenSpawnOk = () => {};
      let unlistenError = () => {};

      const finish = (run: () => void) => {
        clearTimeout(timer);
        unlistenModels();
        unlistenModes();
        unlistenConfigOptions();
        unlistenSpawnOk();
        unlistenError();
        run();
      };

      // An agent that never answers must not leave the panel spinning for ever. The session is
      // closed in `finally` regardless of which way this settles.
      const timer = setTimeout(() => finish(() => resolve(config)), 30_000);

      void listen<{ available_models: AgentModel[]; current_model_id: string }>(
        `acp://session-models/${logId}`,
        (event) => {
          config.models = event.payload.available_models;
          currentModelId = event.payload.current_model_id;
        },
      ).then((fn) => {
        unlistenModels = fn;
      });

      void listen<{ available_modes: AgentMode[] }>(`acp://session-modes/${logId}`, (event) => {
        config.modes = event.payload.available_modes;
      }).then((fn) => {
        unlistenModes = fn;
      });

      // Effort has no event of its own — it is one entry in the generic config-option list, which
      // the reader emits from the same spawn response as the two above, and again with every
      // option refreshed when a config option is set.
      void listen<{ configOptions?: ConfigOption[] }>(
        `acp://config-state-updated/${logId}`,
        (event) => {
          const option = findEffortOption(event.payload.configOptions ?? []);
          config.effort = option
            ? {
                option_id: option.id,
                values: option.options.map((o) => ({ value: o.value, name: o.name })),
              }
            : null;
          // The reader emits the initial one from `spawn_ok.config_options` *before* spawn-ok, so
          // the first to arrive after the model switch is unambiguously its answer.
          if (awaitingModel) finish(() => resolve(config));
        },
      ).then((fn) => {
        unlistenConfigOptions = fn;
      });

      // Settled on spawn-ok, not on the two state events: the reader emits both from
      // `emit_session_init_events` and spawn-ok after, so by here anything the agent declares has
      // arrived. Waiting on either state event alone would hang for every agent that declares none.
      void listen<null>(`acp://spawn-ok/${logId}`, () => {
        spawned = true;
        // A model id means nothing to a harness that did not issue it, and asking for one the
        // agent has not listed is answered with an error the user sees as "Agent failed to start".
        // There is nothing to learn from asking: the effort list we would be waiting for belongs
        // to a model this agent does not have. An empty list is not a refusal — plenty of agents
        // declare no models at all — so only a list that exists and excludes it counts.
        const refused =
          config.models.length > 0 && !config.models.some((m) => m.model_id === modelId);
        if (!modelId || modelId === currentModelId || refused) {
          finish(() => resolve(config));
          return;
        }
        awaitingModel = true;
        // The command only reports whether the request reached the agent; the agent's own refusal
        // comes back as a session-error, which is handled below. Either way the lists in hand are
        // still worth returning.
        void api.setAcpConfigOption(logId, "model", modelId).catch(() => {
          finish(() => resolve(config));
        });
      }).then((fn) => {
        unlistenSpawnOk = fn;
      });

      void listen<string>(`acp://session-error/${logId}`, (event) =>
        finish(() => (spawned ? resolve(config) : reject(new Error(event.payload)))),
      ).then((fn) => {
        unlistenError = fn;
      });
    });
  } finally {
    await api.cancelAcpSession(logId).catch((err: unknown) => {
      console.warn("Failed to close config probe session:", err);
    });
  }
}

/**
 * Cached for the life of the project, not on a timer.
 *
 * A probe is not a read — it spawns an agent subprocess and kills it again — and the answer does
 * not change while the app is open. A five-minute window meant closing settings and reopening it
 * later paid for the whole thing again, for a list that had not moved. The key carries `cwd`, so
 * opening another project probes afresh.
 *
 * It also carries `modelId`, because the answer is a property of the *session's model* rather than
 * of the installed agent: switching a profile's model has to re-ask, and that re-probe is the only
 * way the effort list can be right for a profile that does not run the agent's default. The cost
 * is one extra subprocess per (agent, cwd, model) the user actually picks.
 *
 * `gcTime` matters as much as `staleTime` here: the probe's only observers are the profile cards,
 * so leaving settings unmounts all of them and a collected entry is re-probed on the way back in.
 *
 * No `placeholderData`: callers reset a stored value the agent turns out not to offer, and they
 * gate that on the query having reached a settled state. Serving the previous model's answer
 * through a re-probe would present that stale list as a settled one, and a value would be cleared
 * against the wrong model's options.
 *
 * The cost is that an agent updated underneath a running app keeps reporting its old lists until
 * restart. That is the same bargain `useAgentDiscoveryQuery` already makes.
 */
export function useAgentConfigQuery(
  agentId: string | null,
  cwd: string | null,
  projectId: number | null,
  connection: ConnectionKey,
  modelId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: executionQueryKeys.agentConfig(agentId ?? "", cwd ?? "", connection, modelId ?? ""),
    queryFn: () => probeAgentConfig(agentId!, cwd!, projectId!, connection, modelId),
    enabled: enabled && !!agentId && !!cwd && projectId != null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/**
 * Active session list. Invalidated by the app-wide `sessions-changed` subscription in
 * `useServerEventSync` rather than a listener of its own — this hook is called per card, so a
 * subscription here was one native listener per caller.
 *
 * The slow poll is its own concern and stays: a checkout inside a session's directory changes the
 * branch it reports and emits no event.
 */
export function useActiveSessionsQuery(projectId: number | undefined) {
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
 *
 * `refetchInterval` is off by default because `cwd` and `project_id` are fixed for a session's
 * lifetime. `session_start_sha` is not: `get_acp_session_meta` reports it as absent once a rebase,
 * amend or reset has orphaned the commit, and callers that diff against it need to hear about that
 * to fall back. Panels stay mounted for the app's lifetime and `refetchOnWindowFocus` is off
 * globally, so without an interval this answer is the one fetched at mount, forever.
 */
export function useAcpSessionMeta(
  sessionKey: number | null,
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: executionQueryKeys.sessionMeta(sessionKey),
    queryFn: () => api.getAcpSessionMeta(sessionKey!),
    enabled: sessionKey != null,
    refetchInterval: options?.refetchInterval ?? false,
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
