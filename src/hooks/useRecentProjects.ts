import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types/bindings";

export function useRecentProjects(connectionId?: number | null) {
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecent = useCallback(async () => {
    try {
      setLoading(true);
      const projects = await invoke<Project[]>("get_connection_projects", {
        connectionId: connectionId ?? null
      });
      setRecentProjects(projects);
    } catch (err) {
      console.error("Failed to load connection projects:", err);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  return { recentProjects, loading, refetch: loadRecent };
}
