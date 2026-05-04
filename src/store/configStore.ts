import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// These constants are used by TaskSettingsModal for per-task overrides.
// They remain hardcoded until task-level model/MCP discovery is implemented.
export const AVAILABLE_MCP_SERVERS = ["filesystem", "web", "git"];
export const AVAILABLE_SKILLS = ["javascript", "python", "react", "rust"];
export const AVAILABLE_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

export interface ConfigState {
  default_agent: string | null;
  default_model: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setState: (config: Partial<Pick<ConfigState, "default_agent" | "default_model" | "isLoading" | "error">>) => void;
  setDefaultAgent: (agent: string | null) => void;
  setDefaultModel: (model: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  resetConfig: () => void;
  clearConfig: () => void;
}

function applyReset(state: ConfigState) {
  state.default_agent = null;
  state.default_model = null;
  state.isLoading = false;
  state.error = null;
}

export const useConfigStore = create<ConfigState>()(
  immer((set) => ({
    default_agent: null,
    default_model: null,
    isLoading: false,
    error: null,

    setState: (config) =>
      set((state) => {
        if (config.default_agent !== undefined) state.default_agent = config.default_agent ?? null;
        if (config.default_model !== undefined) state.default_model = config.default_model ?? null;
        if (config.isLoading !== undefined) state.isLoading = config.isLoading;
        if (config.error !== undefined) state.error = config.error ?? null;
      }),

    setDefaultAgent: (agent) =>
      set((state) => { state.default_agent = agent; }),

    setDefaultModel: (model) =>
      set((state) => { state.default_model = model; }),

    setLoading: (loading) =>
      set((state) => { state.isLoading = loading; }),

    setError: (error) =>
      set((state) => { state.error = error; }),

    clearError: () =>
      set((state) => { state.error = null; }),

    resetConfig: () => set(applyReset),
    clearConfig: () => set(applyReset),
  })),
);
