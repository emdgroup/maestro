import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { Task, TaskStatus } from "../types/bindings";

export interface BoardState {
  tasks: Task[];
  activeTerminalTaskId: number | null;
  isTerminalOpen: boolean;
  loadTasks: (tasks: Task[]) => void;
  updateTaskStatus: (taskId: number, newStatus: TaskStatus) => void;
  addTask: (task: Task) => void;
  getTasks: () => Task[];
  getTasksByStatus: (status: TaskStatus) => Task[];
  executeTask: (projectId: number, taskId: number, repoPath: string) => Promise<number>;
  openTerminal: (taskId: number) => void;
  closeTerminal: () => Promise<void>;
}

export const useBoardStore = create<BoardState>()(
  immer((set, get) => ({
    tasks: [],
    activeTerminalTaskId: null,
    isTerminalOpen: false,

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
          await invoke("detach_terminal", { task_id: state.activeTerminalTaskId });
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
