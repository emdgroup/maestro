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
  sessions: Record<string, SessionActivityInfo>;
  setActivity: (sessionId: string, status: SessionActivityStatus, label?: string | null) => void;
  resetIfStale: (sessionId: string) => void;
  markSeen: (sessionId: string) => void;
  removeActivity: (sessionId: string) => void;
}

export const useSessionActivityStore = create<SessionActivityState>()(
  immer((set) => ({
    sessions: {},
    setActivity: (sessionId, status, label = null) =>
      set((state) => {
        const existing = state.sessions[sessionId];
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
          state.sessions[sessionId] = {
            status,
            stateChangedAt: Date.now(),
            label: label ?? null,
            seen: true,
          };
        }
      }),
    resetIfStale: (sessionId) =>
      set((state) => {
        const existing = state.sessions[sessionId];
        if (existing?.status === "stale") {
          existing.status = "idle";
          existing.stateChangedAt = Date.now();
        }
      }),
    markSeen: (sessionId) =>
      set((state) => {
        const existing = state.sessions[sessionId];
        if (existing && existing.status === "idle" && !existing.seen) {
          existing.seen = true;
        }
      }),
    removeActivity: (sessionId) =>
      set((state) => {
        delete state.sessions[sessionId];
      }),
  })),
);

export const useActivitySessions = () => useSessionActivityStore((s) => s.sessions);
export const useSessionActivity = (key: string | undefined) =>
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
