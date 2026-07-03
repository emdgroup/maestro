import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";

export type SessionActivityStatus =
  | "spawning"
  | "thinking"
  | "acting"
  | "awaiting_input"
  | "idle"
  | "stale";

export interface SessionActivityInfo {
  status: SessionActivityStatus;
  stateChangedAt: number;
  label: string | null;
  seen: boolean;
}

interface SessionActivityState {
  sessions: Record<number, SessionActivityInfo>;
  setActivity: (executionId: number, status: SessionActivityStatus, label?: string | null) => void;
  resetIfStale: (executionId: number) => void;
  markSeen: (executionId: number) => void;
  removeActivity: (executionId: number) => void;
}

export const useSessionActivityStore = create<SessionActivityState>()(
  immer((set) => ({
    sessions: {},
    setActivity: (executionId, status, label = null) =>
      set((state) => {
        const existing = state.sessions[executionId];
        if (existing) {
          const normalizedLabel = label ?? null;
          if (existing.status === status && existing.label === normalizedLabel) return;
          if (existing.status !== status) {
            existing.stateChangedAt = Date.now();
            // Reset seen so the session row shows a pulse dot until the user opens it.
            if (status === "idle") {
              existing.seen = false;
            }
          }
          existing.status = status;
          existing.label = normalizedLabel;
        } else {
          state.sessions[executionId] = {
            status,
            stateChangedAt: Date.now(),
            label: label ?? null,
            seen: true,
          };
        }
      }),
    resetIfStale: (executionId) =>
      set((state) => {
        const existing = state.sessions[executionId];
        if (existing?.status === "stale") {
          existing.status = "idle";
          existing.stateChangedAt = Date.now();
        }
      }),
    markSeen: (executionId) =>
      set((state) => {
        const existing = state.sessions[executionId];
        if (existing && existing.status === "idle" && !existing.seen) {
          existing.seen = true;
        }
      }),
    removeActivity: (executionId) =>
      set((state) => {
        delete state.sessions[executionId];
      }),
  })),
);

export const useActivitySessions = () => useSessionActivityStore((s) => s.sessions);
export const useSessionActivity = (key: number | undefined) =>
  useSessionActivityStore((s) => (key != null ? s.sessions[key] : undefined));
export const useSessionActivityActions = () =>
  useSessionActivityStore(
    useShallow((s) => ({
      setActivity: s.setActivity,
      resetIfStale: s.resetIfStale,
      markSeen: s.markSeen,
      removeActivity: s.removeActivity,
    })),
  );
