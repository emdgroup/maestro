import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import { api } from "@/lib/tauri-utils";

export interface BoardState {
  activeTerminalTaskId: number | null;
  isTerminalOpen: boolean;
  openTerminal: (taskId: number) => void;
  closeTerminal: () => Promise<void>;
}

export const useBoardStore = create<BoardState>()(
  immer((set, get) => ({
    activeTerminalTaskId: null,
    isTerminalOpen: false,

    openTerminal: (taskId: number) => {
      set((state) => {
        state.activeTerminalTaskId = taskId;
        state.isTerminalOpen = true;
      });
    },

    closeTerminal: async () => {
      const state = get();
      if (state.activeTerminalTaskId !== null) {
        try {
          await api.detachTerminal(state.activeTerminalTaskId);
        } catch (err) {
          console.error("Error detaching terminal:", err);
        }
      }

      set((state) => {
        state.isTerminalOpen = false;
        state.activeTerminalTaskId = null;
      });
    },
  })),
);

export const useActiveTerminalTaskId = () => useBoardStore((s) => s.activeTerminalTaskId);
export const useIsTerminalOpen = () => useBoardStore((s) => s.isTerminalOpen);
export const useBoardActions = () =>
  useBoardStore(
    useShallow((s) => ({
      openTerminal: s.openTerminal,
      closeTerminal: s.closeTerminal,
    })),
  );
