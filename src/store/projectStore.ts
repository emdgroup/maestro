import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import type { Project } from "@/types/bindings";
import { api } from "@/lib/tauri-utils";

interface ProjectState {
  selectedProject: Project | null;
  setSelectedProject: (project: Project) => void;
  clearSelectedProject: () => void;
}

const useStore = create<ProjectState>()(
  immer((set) => ({
    selectedProject: null,
    setSelectedProject: (project) =>
      set((state) => {
        state.selectedProject = project;
      }),
    clearSelectedProject: () => {
      void api.releaseActiveProjectLock().catch(console.error);
      set((state) => {
        state.selectedProject = null;
      });
    },
  })),
);

export const useSelectedProject = () => useStore((state) => state.selectedProject);
export const useSelectedProjectActions = () =>
  useStore(
    useShallow((state) => ({
      setSelectedProject: state.setSelectedProject,
      clearSelectedProject: state.clearSelectedProject,
    })),
  );
