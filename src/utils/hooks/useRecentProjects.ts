import { useQuery } from "@tanstack/react-query";
import { api } from "@/utils/helpers/tauri-utils";
import type { Project } from "@/types/bindings";

/**
 * Query key factory for connection projects
 */
export const connectionProjectsQueryKeys = {
  all: ["connectionProjects"] as const,
  lists: () => [...connectionProjectsQueryKeys.all, "list"] as const,
  byConnection: (connectionId: number | null | undefined) =>
    [...connectionProjectsQueryKeys.lists(), connectionId] as const,
};

/**
 * Hook for fetching projects for a specific SSH connection
 * Replaces direct invoke("get_connection_projects") calls
 */
export function useRecentProjects(connectionId: number | undefined | null) {
  return useQuery({
    queryKey: connectionProjectsQueryKeys.byConnection(connectionId),
    queryFn: () => api.getConnectionProjects(connectionId || null),
    enabled: connectionId !== null && connectionId !== undefined,
    staleTime: 300000, // 5 minutes - projects don't change often
    refetchOnWindowFocus: true,
  });
}
