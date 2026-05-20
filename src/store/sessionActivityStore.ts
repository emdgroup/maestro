import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";

export type SessionActivityStatus = "spawning" | "thinking" | "acting" | "awaiting_input" | "idle";

export interface SessionActivityInfo {
  status: SessionActivityStatus;
  stateChangedAt: number;
  label: string | null;
}

interface SessionActivityState {
  sessions: Record<number, SessionActivityInfo>;
  setActivity: (executionId: number, status: SessionActivityStatus, label?: string | null) => void;
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
          }
          existing.status = status;
          existing.label = normalizedLabel;
        } else {
          state.sessions[executionId] = {
            status,
            stateChangedAt: Date.now(),
            label: label ?? null,
          };
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
      removeActivity: s.removeActivity,
    })),
  );
