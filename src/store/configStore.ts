import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/shallow";
import type { ConnectionKey, ToolCheckEntry } from "@/types/bindings";

// These constants are used by TaskSettingsModal for per-task overrides.
export const AVAILABLE_MCP_SERVERS = ["filesystem", "web", "git"];
export const AVAILABLE_SKILLS = ["javascript", "python", "react", "rust"];

export interface ConfigState {
  default_agent: string | null;
  isLoading: boolean;
  error: string | null;
  preflightToolChecks: Record<string, ToolCheckEntry[]>;

  // Actions
  setState: (config: Partial<Pick<ConfigState, "default_agent" | "isLoading" | "error">>) => void;
  setDefaultAgent: (agent: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  resetConfig: () => void;
  setPreflightToolChecks: (connection: ConnectionKey, toolChecks: ToolCheckEntry[]) => void;
}

function connectionKeyStr(connection: ConnectionKey): string {
  if (connection.type === "local") return "local";
  return `${connection.type}:${connection.id}`;
}

function applyReset(state: ConfigState) {
  state.default_agent = null;
  state.isLoading = false;
  state.error = null;
}

export const useConfigStore = create<ConfigState>()(
  immer((set) => ({
    default_agent: null,
    isLoading: false,
    error: null,
    preflightToolChecks: {},

    setState: (config) =>
      set((state) => {
        if (config.default_agent !== undefined) state.default_agent = config.default_agent ?? null;
        if (config.isLoading !== undefined) state.isLoading = config.isLoading;
        if (config.error !== undefined) state.error = config.error ?? null;
      }),

    setDefaultAgent: (agent) =>
      set((state) => {
        state.default_agent = agent;
      }),

    setLoading: (loading) =>
      set((state) => {
        state.isLoading = loading;
      }),

    setError: (error) =>
      set((state) => {
        state.error = error;
      }),

    clearError: () =>
      set((state) => {
        state.error = null;
      }),

    resetConfig: () => set(applyReset),

    setPreflightToolChecks: (connection, toolChecks) =>
      set((state) => {
        state.preflightToolChecks[connectionKeyStr(connection)] = toolChecks;
      }),
  })),
);

export const useDefaultAgent = () => useConfigStore((s) => s.default_agent);
export const useConfigIsLoading = () => useConfigStore((s) => s.isLoading);
export const useConfigError = () => useConfigStore((s) => s.error);
export const useConfigActions = () =>
  useConfigStore(
    useShallow((s) => ({
      setState: s.setState,
      setDefaultAgent: s.setDefaultAgent,
      setLoading: s.setLoading,
      setError: s.setError,
      clearError: s.clearError,
      resetConfig: s.resetConfig,
      setPreflightToolChecks: s.setPreflightToolChecks,
    })),
  );

const EMPTY_TOOL_CHECKS: ToolCheckEntry[] = [];
export const usePreflightToolChecks = (connection: ConnectionKey) =>
  useConfigStore((s) => s.preflightToolChecks[connectionKeyStr(connection)] ?? EMPTY_TOOL_CHECKS);
