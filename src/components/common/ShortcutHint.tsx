import { useIsHintVisible } from "@/store/shortcutStore";
import { useActiveTab, useActiveTaskId } from "@/store/navigationStore";
import { getShortcutById, isScopeActive } from "@/shortcuts/registry";
import { ShortcutHintTooltip } from "./ShortcutHintTooltip";
import type { ShortcutScope } from "@/shortcuts/types";

interface ShortcutHintProps {
  shortcutId: string;
  children: React.ReactNode;
  placement?: "above" | "below";
}

export function ShortcutHint({ shortcutId, children, placement = "below" }: ShortcutHintProps) {
  const isHintVisible = useIsHintVisible();
  const activeTab = useActiveTab();
  const activeTaskId = useActiveTaskId();

  const shortcut = getShortcutById(shortcutId);

  const isRelevant =
    shortcut != null &&
    (Array.isArray(shortcut.scope) ? (shortcut.scope as ShortcutScope[]) : [shortcut.scope]).some(
      (sc) => isScopeActive(sc, activeTab, activeTaskId),
    );

  return (
    <span className="relative inline-flex">
      {children}
      {isHintVisible && isRelevant && shortcut && (
        <ShortcutHintTooltip keyLabel={shortcut.label} placement={placement} />
      )}
    </span>
  );
}
