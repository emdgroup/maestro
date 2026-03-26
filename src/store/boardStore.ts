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

    executeTask: async (projectId: number, taskId: number, repoPath: string) => {
      try {
        // Call executionService to spawn agent
        const executionLogId = await api.spawnAgentExecution(projectId, taskId, repoPath);

        // Update task status to InProgress using immer middleware
        set((state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = "InProgress";
          }
        });

        return executionLogId;
      } catch (error) {
        console.error("Execute task failed:", error);
        throw error;
      }
    },

    pauseExecution: async (taskId: number) => {
      try {
        set((state) => {
          state.pausingTaskIds.add(taskId);
        });

        await api.pauseAgentExecution(taskId);

        // Backend updates database directly. TaskCard will reload execution log.
      } catch (error) {
        console.error("Pause execution failed:", error);
        throw error;
      } finally {
        set((state) => {
          state.pausingTaskIds.delete(taskId);
        });
      }
    },

    resumeExecution: async (projectId: number, taskId: number, repoPath: string) => {
      try {
        // Call executionService to resume agent (reuses same config, creates new execution log)
        const executionLogId = await api.resumeAgentExecution(taskId, projectId, repoPath);

        // Update task status to InProgress
        set((state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = "InProgress";
          }
        });

        return executionLogId;
      } catch (error) {
        console.error("Resume execution failed:", error);
        throw error;
      }
    },

    abortExecution: async (_projectId: number, taskId: number) => {
      try {
        // Call cancelExecution handler if available
        // TODO: cancel_execution expects logId, not taskId - this needs to fetch the log first
        try {
          await api.cancelExecution(taskId);
        } catch (err) {
          console.warn("cancelExecution handler not available, marking task manually", err);
        }

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
