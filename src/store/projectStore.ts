import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import type { Project } from "@/types/bindings";
import { api } from "@/lib";

interface ProjectStore {
  selectedProject: Project | null;
  setSelectedProject: (project: Project) => void;
  clearSelectedProject: () => void;
}

const useStore = create<ProjectStore>()(
  immer((set) => ({
    selectedProject: null,
    setSelectedProject: (project) =>
      set((state) => {
        state.selectedProject = project;
      }),
    clearSelectedProject: () => {
      void api.releaseActiveProjectLock();
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
