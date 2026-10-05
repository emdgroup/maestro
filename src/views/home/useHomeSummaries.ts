import type { ConnectionKey, HomeProject } from "@/types/bindings";
import { useHomeSummaries as useSummaryQueries } from "@/services/project.service";
import { connectionKeyId } from "@/store/homeStore";
import type { ProjectCard } from "./ProjectTile";

export interface ConnectionSummary {
  projects: ProjectCard[];
  runningAutomations: number;
  server: { version: string; startedAt: string };
  hostname: string | null;
}

export function toCard(project: HomeProject): ProjectCard {
  return {
    projectId: project.project_id,
    path: project.path,
    name: project.name,
    working: project.working_agents,
    review: project.review,
    queued: project.queued,
    needsYou: project.needs_you > 0,
    blockingPrompt: project.blocking_prompt,
    runningAutomation: project.running_automations[0] ?? null,
    holder: project.lock_yours ? null : project.lock_holder,
  };
}

/** Home's view of each attached connection, keyed by `connectionKeyId`. */
export function useHomeSummaries(connections: ConnectionKey[]): Map<string, ConnectionSummary> {
  const results = useSummaryQueries(connections);
  const summaries = new Map<string, ConnectionSummary>();
  connections.forEach((connection, index) => {
    const data = results[index]?.data;
    if (!data) return;
    summaries.set(connectionKeyId(connection), {
      projects: data.projects.map(toCard),
      runningAutomations: data.running_runs,
      server: { version: data.version, startedAt: data.started_at },
      hostname: data.hostname,
    });
  });
  return summaries;
}
