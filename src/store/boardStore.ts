// Zustand store for terminal drawer and active task state in BoardView.
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
  authRequiredTasks: Record<string, AuthRequiredEntry>;
  pendingAuthRetry: number | null;
  pendingSessionRetry: { sessionId: string; lastPrompt: unknown } | null;
  openTerminal: (taskId: number) => void;
  closeTerminal: () => Promise<void>;
  openReview: (taskId: number) => void;
  closeReview: () => void;
  setAuthRequired: (
    authKey: string,
    agentId: string,
    connection: ConnectionKey,
    lastPrompt: unknown,
  ) => void;
  clearAuthRequired: (authKey: string) => void;
  setAuthTerminalRunning: (authKey: string, terminalId: string) => void;
  setAuthTerminalInterrupted: (authKey: string) => void;
  setAuthTerminalIdle: (authKey: string) => void;
  setPendingAuthRetry: (taskId: number) => void;
  clearPendingAuthRetry: () => void;
  setPendingSessionRetry: (payload: { sessionId: string; lastPrompt: unknown }) => void;
  clearPendingSessionRetry: () => void;
}

export const useBoardStore = create<BoardState>()(
  immer((set, get) => ({
    activeTerminalTaskId: null,
    isTerminalOpen: false,
    reviewPanelTaskId: null,
    authRequiredTasks: {} as Record<string, AuthRequiredEntry>,
    pendingAuthRetry: null,
    pendingSessionRetry: null,

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
          await api.detachTerminal(String(state.activeTerminalTaskId));
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

    setAuthRequired: (authKey, agentId, connection, lastPrompt) =>
      set((state) => {
        state.authRequiredTasks[authKey] = {
          agentId,
          connection,
          lastPrompt,
          terminalState: "idle",
          terminalId: null,
        };
      }),

    clearAuthRequired: (authKey) =>
      set((state) => {
        delete state.authRequiredTasks[authKey];
      }),

    setAuthTerminalRunning: (authKey, terminalId) =>
      set((state) => {
        const entry = state.authRequiredTasks[authKey];
        if (entry) {
          entry.terminalState = "running";
          entry.terminalId = terminalId;
        }
      }),

    setAuthTerminalInterrupted: (authKey) =>
      set((state) => {
        const entry = state.authRequiredTasks[authKey];
        if (entry) {
          entry.terminalState = "interrupted";
        }
      }),

    setAuthTerminalIdle: (authKey) =>
      set((state) => {
        const entry = state.authRequiredTasks[authKey];
        if (entry) {
          entry.terminalState = "idle";
          entry.terminalId = null;
        }
      }),

    setPendingAuthRetry: (taskId) =>
      set((state) => {
        state.pendingAuthRetry = taskId;
      }),

    clearPendingAuthRetry: () =>
      set((state) => {
        state.pendingAuthRetry = null;
      }),

    setPendingSessionRetry: (payload) =>
      set((state) => {
        state.pendingSessionRetry = payload;
      }),

    clearPendingSessionRetry: () =>
      set((state) => {
        state.pendingSessionRetry = null;
      }),
  })),
);

export const useActiveTerminalTaskId = () => useBoardStore((s) => s.activeTerminalTaskId);
export const useIsTerminalOpen = () => useBoardStore((s) => s.isTerminalOpen);
export const useReviewPanelTaskId = () => useBoardStore((s) => s.reviewPanelTaskId);
export const useAuthRequiredTask = (authKey: string) =>
  useBoardStore((s) => s.authRequiredTasks[authKey]);

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
      setPendingAuthRetry: s.setPendingAuthRetry,
      clearPendingAuthRetry: s.clearPendingAuthRetry,
      setPendingSessionRetry: s.setPendingSessionRetry,
      clearPendingSessionRetry: s.clearPendingSessionRetry,
    })),
  );
