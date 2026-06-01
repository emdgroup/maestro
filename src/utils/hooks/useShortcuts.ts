import { useEffect, useRef } from "react";
import { useActiveTab, useActiveTaskId } from "@/store/navigationStore";
import { getShortcutsForScope, isScopeActive } from "@/shortcuts/registry";
import type { ShortcutScope } from "@/shortcuts/types";

type ShortcutHandlers = Partial<Record<string, () => void>>;

export function useShortcuts(scope: ShortcutScope, handlers: ShortcutHandlers): void {
  const activeTab = useActiveTab();
  const activeTaskId = useActiveTaskId();

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const stateRef = useRef({ activeTab, activeTaskId });
  stateRef.current = { activeTab, activeTaskId };

  useEffect(() => {
    const defs = getShortcutsForScope(scope);

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const { activeTab: tab, activeTaskId: taskId } = stateRef.current;
      if (!isScopeActive(scope, tab, taskId)) return;

      for (const def of defs) {
        const keyMatch =
          def.key === "Escape"
            ? e.key === "Escape"
            : e.key.toLowerCase() === def.key.toLowerCase();
        if (keyMatch && def.ctrl === e.ctrlKey) {
          const handler = handlersRef.current[def.id];
          if (handler) {
            e.preventDefault();
            handler();
          }
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scope]);
}
