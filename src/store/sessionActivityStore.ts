import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export type SessionActivityStatus = "spawning" | "working" | "idle" | "awaiting_input";

interface SessionActivityStore {
  statuses: Record<number, SessionActivityStatus>;
  setStatus: (executionId: number, status: SessionActivityStatus) => void;
  removeStatus: (executionId: number) => void;
}

export const useSessionActivityStore = create<SessionActivityStore>()(
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
