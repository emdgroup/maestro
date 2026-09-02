import { useEffect, useRef } from "react";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useProjectSettings, useUpdateProjectSettings } from "@/services/project.service";
import type { ConnectionKey, ProjectConfigResponse } from "@/types/bindings";

interface FallbackInputs {
  projectId: number | null;
  /** False while either query is in flight — a still-loading `null` is not "has no default". */
  ready: boolean;
  defaultAgent: string | null;
  /** Discovered agent ids, in the order the picker shows them. */
  agentIds: string[];
  /** Projects this session has already written for, so a slow write is not repeated. */
  applied: ReadonlySet<number>;
}

/**
 * The agent id to adopt as this project's default, or `null` to leave the setting alone.
 *
 * Pure so the guards can be tested without a query client. Every one of them matters: firing
 * before the queries resolve would write a default off an empty discovery list, and firing twice
 * would race the settings write against its own invalidation.
 */
export function resolveDefaultAgentFallback({
  projectId,
  ready,
  defaultAgent,
  agentIds,
  applied,
}: FallbackInputs): string | null {
  if (projectId == null || !ready) return null;
  if (defaultAgent != null) return null;
  if (applied.has(projectId)) return null;
  return agentIds[0] ?? null;
}

/**
 * Gives a project with no default agent the first one installed on its connection.
 *
 * Without this, a project that has never opened Settings cannot start a task at all: the
 * Implementation stage falls back to the project default when no profile names an agent, and
 * profiles start empty. "No agent to run the Implementation stage" was the first thing a new user
 * saw, and nothing on the board said the answer was two pages away in Settings.
 *
 * The choice is persisted rather than resolved at spawn time so that Settings can show it — a
 * default the user cannot see is one they cannot correct. The cost is real and deliberate:
 * `.maestro/settings.json` is the project's shared file, so an agent discovered on *this* machine
 * is written for whoever else opens the repository. It is one editable line in a file they can
 * already see, which is a better trade than an app that refuses to run.
 *
 * Modelled on the accent auto-assignment in `ThemeProvider`, down to the once-per-project ref:
 * the settings query is invalidated by the write, so a guard that lived in the query data alone
 * would let a second render fire before the first write landed.
 */
export function useDefaultAgentFallback(projectId: number | null, connection: ConnectionKey) {
  const settingsQuery = useProjectSettings(projectId);
  const discoveryQuery = useAgentDiscoveryQuery(connection, projectId != null);
  const updateSettings = useUpdateProjectSettings();

  const appliedRef = useRef(new Set<number>());

  const settings = settingsQuery.data;
  const agentIds = discoveryQuery.data?.agents.map((agent) => agent.id) ?? [];

  useEffect(() => {
    const agentId = resolveDefaultAgentFallback({
      projectId,
      ready: settingsQuery.isSuccess && discoveryQuery.isSuccess,
      defaultAgent: settings?.default_agent ?? null,
      agentIds,
      applied: appliedRef.current,
    });
    if (agentId == null || projectId == null || !settings) return;

    appliedRef.current.add(projectId);
    updateSettings.mutate({ projectId, config: requestFrom(settings, agentId) });
    // `agentIds` is a fresh array every render; the query's own success flag and length are what
    // actually change, and depending on the array would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    settingsQuery.isSuccess,
    discoveryQuery.isSuccess,
    settings?.default_agent,
    agentIds.length,
  ]);
}

/// The update command takes the whole config, so every field the response carries and the request
/// also has must be copied across or it is written away. Same merge `SettingsPage` performs.
function requestFrom(settings: ProjectConfigResponse, defaultAgent: string) {
  return {
    default_agent: defaultAgent,
    startup_tab: settings.startup_tab,
    default_workspace_mode: settings.default_workspace_mode,
    remote_name: settings.remote_name,
    base_branch: settings.base_branch,
  };
}
