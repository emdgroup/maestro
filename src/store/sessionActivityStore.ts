import { create } from "zustand";

export type SessionActivityStatus = "spawning" | "working" | "idle" | "awaiting_input";

interface SessionActivityStore {
  statuses: Map<number, SessionActivityStatus>;
  setStatus: (executionId: number, status: SessionActivityStatus) => void;
  removeStatus: (executionId: number) => void;
}

export const useSessionActivityStore = create<SessionActivityStore>((set) => ({
  statuses: new Map(),
  setStatus: (executionId, status) =>
    set((state) => {
      const next = new Map(state.statuses);
      next.set(executionId, status);
      return { statuses: next };
    }),
  removeStatus: (executionId) =>
    set((state) => {
      const next = new Map(state.statuses);
      next.delete(executionId);
      return { statuses: next };
    }),
}));
