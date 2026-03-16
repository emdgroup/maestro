import { create } from "zustand";
import type { Project } from "@/types/bindings";

interface ProjectStore {
  selectedProject: Project | null;
  actions: {
    setSelectedProject: (project: Project) => void;
    clearSelectedProject: () => void;
  };
}

/**
 * Zustand store for managing the currently selected project.
 *
 * This is app-wide state that persists across component unmounts.
 * Used to eliminate callback prop drilling for project selection.
 */
const useStore = create<ProjectStore>((set) => ({
  selectedProject: null,
  actions: {
    setSelectedProject: (project) => set({ selectedProject: project }),
    clearSelectedProject: () => set({ selectedProject: null }),
  },
}));

export const useSelectedProject = () => useStore((state) => state.selectedProject);
export const useSelectedProjectActions = () => useStore((state) => state.actions);
