import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { ConnectionKey } from "@/types/bindings";

/** Maestro agent id to whether the skill is installed for it. */
export type SkillAgents = Partial<Record<string, boolean>>;

export const skillQueryKeys = {
  list: (connection: ConnectionKey) => ["skills", connection] as const,
  listFor: (connection: ConnectionKey, projectPath: string) =>
    ["skills", connection, projectPath] as const,
  catalog: (query: string) => ["skills-catalog", query] as const,
};

/**
 * The skills in the connection's library, the agents the skills CLI can install for, Maestro's
 * own skills, and the ones the project carries.
 */
export function useSkillsQuery(connection: ConnectionKey, projectPath: string) {
  return useQuery({
    queryKey: skillQueryKeys.listFor(connection, projectPath),
    queryFn: () => api.listSkills(connection, projectPath),
  });
}

/**
 * skills.sh, most installed first: its leaderboard 200 at a time with no query, a search with one.
 * Kept until the refresh button asks again: skills.sh allows 30 requests a minute.
 */
export function useSkillsCatalogQuery(query: string) {
  return useInfiniteQuery({
    queryKey: skillQueryKeys.catalog(query),
    queryFn: ({ pageParam }) => api.skillsCatalog(query || null, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.next_page,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

function useInvalidateSkills(connection: ConnectionKey) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: skillQueryKeys.list(connection) });
}

export function useSaveSkillMutation(connection: ConnectionKey) {
  const invalidate = useInvalidateSkills(connection);
  return useMutation({
    mutationFn: ({
      name,
      skillMd,
      agents,
    }: {
      name: string;
      skillMd: string;
      agents: SkillAgents;
    }) => api.saveSkill(connection, name, skillMd, agents),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to save the skill"),
  });
}

export function useSetSkillAgentsMutation(connection: ConnectionKey) {
  const invalidate = useInvalidateSkills(connection);
  return useMutation({
    mutationFn: ({ name, agents }: { name: string; agents: SkillAgents }) =>
      api.setSkillAgents(connection, name, agents),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to update the skill"),
  });
}

export function useDeleteSkillMutation(connection: ConnectionKey) {
  const invalidate = useInvalidateSkills(connection);
  return useMutation({
    mutationFn: (name: string) => api.deleteSkill(connection, name),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to remove the skill"),
  });
}

export function useInstallCatalogSkillMutation(connection: ConnectionKey) {
  const invalidate = useInvalidateSkills(connection);
  return useMutation({
    mutationFn: ({
      source,
      skillId,
      agents,
    }: {
      source: string;
      skillId: string;
      agents: SkillAgents;
    }) => api.installCatalogSkill(connection, source, skillId, agents),
    onSuccess: invalidate,
    onError: createErrorToastHandler("Failed to install the skill"),
  });
}

/**
 * A catalog skill's description, read from its `SKILL.md`. `enabled` once its card is on screen,
 * so a page of 200 cards costs only the downloads someone scrolls to. Kept for the session.
 */
export function useSkillDescriptionQuery(source: string, skillId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["skill-description", source, skillId] as const,
    queryFn: () => api.skillDescription(source, skillId),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
}
