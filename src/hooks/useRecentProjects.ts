import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types/bindings";

export function useRecentProjects() {
  const [recentProjects, setRecentProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecent = useCallback(async () => {
    try {
      setLoading(true);
      const enhanced = await invoke<Project[]>("get_recent_projects_enhanced");
      setRecentProjects(enhanced);
    } catch (err) {
      console.error("Failed to load recent projects:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  return { recentProjects, loading, refetch: loadRecent };
}
