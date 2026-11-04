// Zustand store tracking the selected project; use useSelectedProject() to read it.
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";
import type { Project } from "@/types/bindings";
import { releaseActiveProjectLock } from "@/services/project.service";

interface ProjectState {
  selectedProject: Project | null;
  isGitRepo: boolean;
  setSelectedProject: (project: Project, isGitRepo?: boolean) => void;
  clearSelectedProject: () => void;
}

const useStore = create<ProjectState>()(
  immer((set) => ({
    selectedProject: null,
    isGitRepo: true,
    setSelectedProject: (project, isGitRepo = true) =>
      set((state) => {
        state.selectedProject = project;
        state.isGitRepo = isGitRepo;
      }),
    clearSelectedProject: () => {
      void releaseActiveProjectLock().catch(console.error);
      set((state) => {
        state.selectedProject = null;
        state.isGitRepo = true;
      });
    },
  })),
);

export const useSelectedProject = () => useStore((state) => state.selectedProject);
export const useIsGitRepo = () => useStore((state) => state.isGitRepo);
export const useSelectedProjectActions = () =>
  useStore(
    useShallow((state) => ({
      setSelectedProject: state.setSelectedProject,
      clearSelectedProject: state.clearSelectedProject,
    })),
  );
