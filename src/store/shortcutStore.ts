import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface ShortcutState {
  isHintVisible: boolean;
  setHintVisible: (visible: boolean) => void;
}

export const useShortcutStore = create<ShortcutState>()(
  immer((set) => ({
    isHintVisible: false,
    setHintVisible: (visible) =>
      set((state) => {
        state.isHintVisible = visible;
      }),
  })),
);

export const useIsHintVisible = () => useShortcutStore((s) => s.isHintVisible);
