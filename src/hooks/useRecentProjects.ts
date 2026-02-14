import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface EnhancedRecentProject {
  path: string;
  name: string;
  is_remote: boolean;
  host: string | null;
  username: string | null;
  last_opened: string;
}

export function useRecentProjects() {
  const [recentProjects, setRecentProjects] = useState<EnhancedRecentProject[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRecent = useCallback(async () => {
    try {
      setLoading(true);
      const enhanced = await invoke<EnhancedRecentProject[]>('get_recent_projects_enhanced');
      setRecentProjects(enhanced);
    } catch (err) {
      console.error('Failed to load recent projects:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  return { recentProjects, loading, refetch: loadRecent };
}
