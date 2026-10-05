import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ConnectionKey, PreflightResult } from "@/types/bindings";

/**
 * Where one connection stands on Home.
 *
 * `idle` is a connection not attached this session: its panel is one row with a Connect pill.
 * Once attached a connection stays attached until the app closes, so this outlives Home itself:
 * opening a project and coming back finds every panel as it was left.
 */
export type ConnectionPhase =
  | { kind: "idle" }
  | { kind: "signin"; error: string | null }
  /** Step 0 signs in or reaches the host, 1 reaches the Maestro server, 2 reads the projects. */
  | { kind: "connecting"; step: 0 | 1 | 2 }
  | { kind: "up" }
  /** The connect stopped short: the server is busy with another build, or tools are missing. */
  | { kind: "failed"; error: string | null; result: PreflightResult | null }
  | { kind: "stopped" }
  | { kind: "unreachable" };

export function connectionKeyId(connection: ConnectionKey): string {
  return connection.type === "local" ? "local" : `${connection.type}:${connection.id}`;
}

const MINIMIZED_KEY = "home.minimized";

function readMinimized(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(MINIMIZED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface HomeState {
  phases: Record<string, ConnectionPhase>;
  /** Connections in the order they were attached this session, which is the order Home lists them. */
  attachedOrder: string[];
  /** Collapsed panels, remembered across restarts. */
  minimized: string[];
  setPhase: (id: string, phase: ConnectionPhase) => void;
  toggleMinimized: (id: string) => void;
}

export const useHomeStore = create<HomeState>()(
  immer((set) => ({
    phases: {},
    attachedOrder: [],
    minimized: readMinimized(),

    setPhase: (id, phase) =>
      set((state) => {
        state.phases[id] = phase;
        // Signing in and connecting keep the panel where it was; it joins the attached ones after.
        const settled =
          phase.kind !== "idle" && phase.kind !== "signin" && phase.kind !== "connecting";
        if (settled && !state.attachedOrder.includes(id)) {
          state.attachedOrder.push(id);
        }
      }),

    toggleMinimized: (id) =>
      set((state) => {
        state.minimized = state.minimized.includes(id)
          ? state.minimized.filter((other) => other !== id)
          : [...state.minimized, id];
        localStorage.setItem(MINIMIZED_KEY, JSON.stringify(state.minimized));
      }),
  })),
);
