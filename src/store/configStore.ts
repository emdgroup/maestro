import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ConnectionKey, ToolCheckEntry } from "@/types/bindings";
import { connectionKeyStr } from "@/lib/connection-utils";

/**
 * Deliberately does not hold the project's default agent.
 *
 * It used to, and nothing ever wrote it: the value lives in `.maestro/settings.json` and is read
 * through `useProjectSettings`, so the copy here sat at `null` for the life of every session and
 * silently disabled the fallback that lets a task run without an agent profile. A second home for
 * a value that belongs to a file is what produced that bug — read the query.
 */
export interface ConfigState {
  preflightToolChecks: Record<string, ToolCheckEntry[]>;
  setPreflightToolChecks: (connection: ConnectionKey, toolChecks: ToolCheckEntry[]) => void;
}

export const useConfigStore = create<ConfigState>()(
  immer((set) => ({
    preflightToolChecks: {},

    setPreflightToolChecks: (connection, toolChecks) =>
      set((state) => {
        state.preflightToolChecks[connectionKeyStr(connection)] = toolChecks;
      }),
  })),
);

const EMPTY_TOOL_CHECKS: ToolCheckEntry[] = [];
export const usePreflightToolChecks = (connection: ConnectionKey) =>
  useConfigStore((s) => s.preflightToolChecks[connectionKeyStr(connection)] ?? EMPTY_TOOL_CHECKS);
