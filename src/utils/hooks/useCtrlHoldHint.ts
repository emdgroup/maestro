import { useEffect } from "react";
import { useShortcutStore } from "@/store/shortcutStore";

const HOLD_DELAY_MS = 1000;

export function useCtrlHoldHint(): void {
  const setHintVisible = useShortcutStore((s) => s.setHintVisible);

  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let ctrlDown = false;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Control" || ctrlDown) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      ctrlDown = true;
      timerId = setTimeout(() => setHintVisible(true), HOLD_DELAY_MS);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== "Control") return;
      ctrlDown = false;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      setHintVisible(false);
    }

    function onBlur() {
      ctrlDown = false;
      if (timerId) {
        clearTimeout(timerId);
        timerId = null;
      }
      setHintVisible(false);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (timerId) clearTimeout(timerId);
    };
  }, [setHintVisible]);
}
