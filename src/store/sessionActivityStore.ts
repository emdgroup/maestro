import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";

export type SessionActivityStatus = "spawning" | "working" | "idle" | "awaiting_input";

interface SessionActivityState {
  statuses: Record<number, SessionActivityStatus>;
  setStatus: (executionId: number, status: SessionActivityStatus) => void;
  removeStatus: (executionId: number) => void;
}

export const useSessionActivityStore = create<SessionActivityState>()(
  immer((set) => ({
    statuses: {},
    setStatus: (executionId, status) =>
      set((state) => {
        state.statuses[executionId] = status;
      }),
    removeStatus: (executionId) =>
      set((state) => {
        delete state.statuses[executionId];
      }),
  })),
);

export const useActivityStatuses = () => useSessionActivityStore((s) => s.statuses);
export const useSessionActivityActions = () =>
  useSessionActivityStore(
    useShallow((s) => ({
      setStatus: s.setStatus,
      removeStatus: s.removeStatus,
    })),
  );
