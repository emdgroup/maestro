import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export interface ConfigState {
  model_default: string;
  mcp_allowlist: string[];
  skills_default: string[];
  isLoading: boolean;
  error: string | null;

  // Actions
  setState: (config: Partial<ConfigState>) => void;
  setModelDefault: (model: string) => void;
  setMcpAllowlist: (list: string[]) => void;
  setSkillsDefault: (list: string[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  resetConfig: () => void;
  clearConfig: () => void;
}

export const AVAILABLE_MCP_SERVERS = ["filesystem", "web", "git"];
export const AVAILABLE_SKILLS = ["javascript", "python", "react", "rust"];
export const AVAILABLE_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

function applyReset(state: ConfigState) {
  state.model_default = "";
  state.mcp_allowlist = [];
  state.skills_default = [];
  state.isLoading = false;
  state.error = null;
}

export const useConfigStore = create<ConfigState>()(
  immer((set) => ({
    // Initial state
    model_default: "",
    mcp_allowlist: [],
    skills_default: [],
    isLoading: false,
    error: null,

    // Actions
    setState: (config: Partial<ConfigState>) =>
      set((state) => {
        if (config.model_default !== undefined) state.model_default = config.model_default;
        if (config.mcp_allowlist !== undefined) state.mcp_allowlist = config.mcp_allowlist;
        if (config.skills_default !== undefined) state.skills_default = config.skills_default;
        if (config.isLoading !== undefined) state.isLoading = config.isLoading;
        if (config.error !== undefined) state.error = config.error;
      }),

    setModelDefault: (model: string) =>
      set((state) => {
        state.model_default = model;
      }),

    setMcpAllowlist: (list: string[]) =>
      set((state) => {
        state.mcp_allowlist = list;
      }),

    setSkillsDefault: (list: string[]) =>
      set((state) => {
        state.skills_default = list;
      }),

    setLoading: (loading: boolean) =>
      set((state) => {
        state.isLoading = loading;
      }),

    setError: (error: string | null) =>
      set((state) => {
        state.error = error;
      }),

    clearError: () =>
      set((state) => {
        state.error = null;
      }),

    resetConfig: () => set(applyReset),
    clearConfig: () => set(applyReset),
  })),
);
