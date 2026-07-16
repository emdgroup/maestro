import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";
import { api } from "@/lib/tauri-utils";
import type { ConnectionKey } from "@/types/bindings";

export interface AuthRequiredEntry {
  agentId: string;
  connection: ConnectionKey;
  // Runtime value may be a string or a JsonValue array (structured content blocks).
  // Typed as unknown to avoid Immer's Immutable<> hitting TS2589 on recursive JsonValue.
  lastPrompt: unknown;
  terminalState: "idle" | "running" | "interrupted";
  terminalId: string | null;
}

export interface BoardState {
  activeTerminalTaskId: number | null;
  isTerminalOpen: boolean;
  reviewPanelTaskId: number | null;
  authRequiredTasks: Record<number, AuthRequiredEntry>;
  openTerminal: (taskId: number) => void;
  closeTerminal: () => Promise<void>;
  openReview: (taskId: number) => void;
  closeReview: () => void;
  setAuthRequired: (
    taskId: number,
    agentId: string,
    connection: ConnectionKey,
    lastPrompt: unknown,
  ) => void;
  clearAuthRequired: (taskId: number) => void;
  setAuthTerminalRunning: (taskId: number, terminalId: string) => void;
  setAuthTerminalInterrupted: (taskId: number) => void;
  setAuthTerminalIdle: (taskId: number) => void;
}

export const useBoardStore = create<BoardState>()(
  immer((set, get) => ({
    activeTerminalTaskId: null,
    isTerminalOpen: false,
    reviewPanelTaskId: null,
    authRequiredTasks: {} as Record<number, AuthRequiredEntry>,

    openTerminal: (taskId: number) => {
      set((state) => {
        state.activeTerminalTaskId = taskId;
        state.isTerminalOpen = true;
      });
    },

    closeTerminal: async () => {
      const state = get();
      if (state.activeTerminalTaskId !== null) {
        try {
          await api.detachTerminal(state.activeTerminalTaskId);
        } catch (err) {
          console.error("Error detaching terminal:", err);
        }
      }

      set((state) => {
        state.isTerminalOpen = false;
        state.activeTerminalTaskId = null;
      });
    },
    openReview: (taskId: number) =>
      set((state) => {
        state.reviewPanelTaskId = taskId;
      }),

    closeReview: () =>
      set((state) => {
        state.reviewPanelTaskId = null;
      }),

    setAuthRequired: (taskId, agentId, connection, lastPrompt) =>
      set((state) => {
        state.authRequiredTasks[taskId] = {
          agentId,
          connection,
          lastPrompt,
          terminalState: "idle",
          terminalId: null,
        };
      }),

    clearAuthRequired: (taskId) =>
      set((state) => {
        delete state.authRequiredTasks[taskId];
      }),

    setAuthTerminalRunning: (taskId, terminalId) =>
      set((state) => {
        const entry = state.authRequiredTasks[taskId];
        if (entry) {
          entry.terminalState = "running";
          entry.terminalId = terminalId;
        }
      }),

    setAuthTerminalInterrupted: (taskId) =>
      set((state) => {
        const entry = state.authRequiredTasks[taskId];
        if (entry) {
          entry.terminalState = "interrupted";
        }
      }),

    setAuthTerminalIdle: (taskId) =>
      set((state) => {
        const entry = state.authRequiredTasks[taskId];
        if (entry) {
          entry.terminalState = "idle";
          entry.terminalId = null;
        }
      }),
  })),
);

export const useActiveTerminalTaskId = () => useBoardStore((s) => s.activeTerminalTaskId);
export const useIsTerminalOpen = () => useBoardStore((s) => s.isTerminalOpen);
export const useReviewPanelTaskId = () => useBoardStore((s) => s.reviewPanelTaskId);
export const useAuthRequiredTask = (taskId: number) =>
  useBoardStore((s) => s.authRequiredTasks[taskId]);

export const useBoardActions = () =>
  useBoardStore(
    useShallow((s) => ({
      openTerminal: s.openTerminal,
      closeTerminal: s.closeTerminal,
      openReview: s.openReview,
      closeReview: s.closeReview,
      setAuthRequired: s.setAuthRequired,
      clearAuthRequired: s.clearAuthRequired,
      setAuthTerminalRunning: s.setAuthTerminalRunning,
      setAuthTerminalInterrupted: s.setAuthTerminalInterrupted,
      setAuthTerminalIdle: s.setAuthTerminalIdle,
    })),
  );
