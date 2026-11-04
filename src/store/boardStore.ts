// Zustand store for the board's review panel and agent sign-in state.
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";
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
  reviewPanelTaskId: number | null;
  authRequiredTasks: Record<string, AuthRequiredEntry>;
  pendingAuthRetry: number | null;
  pendingSessionRetry: { sessionId: string; lastPrompt: unknown } | null;
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
  immer((set) => ({
    reviewPanelTaskId: null,
    authRequiredTasks: {} as Record<string, AuthRequiredEntry>,
    pendingAuthRetry: null,
    pendingSessionRetry: null,

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

export const useReviewPanelTaskId = () => useBoardStore((s) => s.reviewPanelTaskId);
export const useAuthRequiredTask = (authKey: string) =>
  useBoardStore((s) => s.authRequiredTasks[authKey]);

export const useBoardActions = () =>
  useBoardStore(
    useShallow((s) => ({
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
