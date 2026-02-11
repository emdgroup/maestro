import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { Task, TaskStatus } from "../types/bindings";

export interface BoardState {
  tasks: Task[];
  activeTerminalTaskId: number | null;
  isTerminalOpen: boolean;
  retryingTaskIds: Set<number>;
  abortingTaskIds: Set<number>;
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
    retryingTaskIds: new Set<number>(),
    abortingTaskIds: new Set<number>(),
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
        // Invoke spawn_agent_execution handler
        const executionLogId = await invoke<number>("spawn_agent_execution", {
          project_id: projectId,
          task_id: taskId,
          repo_path: repoPath,
        });

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

        await invoke<void>("pause_agent_execution", { taskId: taskId });

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
        // Track retrying state
        set((state) => {
          state.retryingTaskIds.add(taskId);
        });

        // Invoke resume_agent_execution handler (reuses same config, creates new execution log)
        const executionLogId = await invoke<number>("resume_agent_execution", {
          taskId: taskId,
          projectId: projectId,
          repoPath: repoPath,
        });

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
      } finally {
        set((state) => {
          state.retryingTaskIds.delete(taskId);
        });
      }
    },

    abortExecution: async (_projectId: number, taskId: number) => {
      try {
        set((state) => {
          state.abortingTaskIds.add(taskId);
        });

        // Call cancel_execution handler if available, otherwise just mark as Done
        // TODO: cancel_execution expects logId, not taskId - this needs to fetch the log first
        try {
          await invoke("cancel_execution", { logId: taskId });
        } catch (err) {
          console.warn("cancel_execution handler not available, marking task manually");
        }

        // Update task status to Done
        set((state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = "Done";
          }
        });
      } catch (error) {
        console.error("Abort execution failed:", error);
        throw error;
      } finally {
        set((state) => {
          state.abortingTaskIds.delete(taskId);
        });
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
          await invoke("detach_terminal", { taskId: state.activeTerminalTaskId });
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
  }))
);
