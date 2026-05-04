import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { Task, TaskStatus } from "@/types/bindings";
import { api } from "@/lib";

export interface BoardState {
  tasks: Task[];
  activeTerminalTaskId: number | null;
  isTerminalOpen: boolean;
  pausingTaskIds: Set<number>;
  loadTasks: (tasks: Task[]) => void;
  updateTaskStatus: (taskId: number, newStatus: TaskStatus) => void;
  addTask: (task: Task) => void;
  getTasks: () => Task[];
  getTasksByStatus: (status: TaskStatus) => Task[];
  executeTask: (projectId: number, taskId: number, repoPath: string) => Promise<number>;
  pauseExecution: (taskId: number) => Promise<void>;
  resumeExecution: (projectId: number, taskId: number, repoPath: string) => Promise<number>;
  abortExecution: (projectId: number, taskId: number) => Promise<void>;
  openTerminal: (taskId: number) => void;
  closeTerminal: () => Promise<void>;
}

export const useBoardStore = create<BoardState>()(
  immer((set, get) => ({
    tasks: [],
    activeTerminalTaskId: null,
    isTerminalOpen: false,
    pausingTaskIds: new Set<number>(),

    loadTasks: (tasks: Task[]) =>
      set((state) => {
        state.tasks = tasks;
      }),

    updateTaskStatus: (taskId: number, newStatus: TaskStatus) =>
      set((state) => {
        const task = state.tasks.find((t) => t.id === taskId);
        if (task) {
          task.status = newStatus;
        }
      }),

    addTask: (task: Task) =>
      set((state) => {
        state.tasks.push(task);
      }),

    getTasks: () => {
      return get().tasks;
    },

    getTasksByStatus: (status: TaskStatus) => {
      return get().tasks.filter((task) => task.status === status);
    },

    executeTask: async (_projectId: number, _taskId: number, _repoPath: string) => {
      // spawn_agent_execution (sidecar-based) has been removed.
      // Use spawn_interactive_execution via the Agents view instead.
      throw new Error(
        "spawn_agent_execution has been removed. Use spawnInteractiveExecution instead."
      );
    },

    pauseExecution: async (_taskId: number) => {
      throw new Error("pauseExecution removed: use ACP cancel instead");
    },

    resumeExecution: async (_projectId: number, _taskId: number, _repoPath: string) => {
      throw new Error("resumeExecution removed: spawn a new session instead");
    },

    abortExecution: async (_projectId: number, taskId: number) => {
      try {
        // Update task status to Cancelled
        set((state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = "Cancelled";
          }
        });
      } catch (error) {
        console.error("Abort execution failed:", error);
        throw error;
      }
    },

    openTerminal: (taskId: number) => {
      set((state) => {
        state.activeTerminalTaskId = taskId;
        state.isTerminalOpen = true;
      });
    },

    closeTerminal: async () => {
      // Close current terminal gracefully
      const state = get();
      if (state.activeTerminalTaskId !== null) {
        try {
          await api.detachTerminal(state.activeTerminalTaskId);
        } catch (err) {
          console.error("Error detaching terminal:", err);
        }
      }

      // Update state
      set((state) => {
        state.isTerminalOpen = false;
        state.activeTerminalTaskId = null;
      });
    },
  })),
);
