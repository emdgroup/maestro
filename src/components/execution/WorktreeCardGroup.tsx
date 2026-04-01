import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib";

interface WorktreeCardGroupProps {
  groupKey: string;
  count: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  children: React.ReactNode;
}

export function WorktreeCardGroup({
  groupKey,
  count,
  isCollapsed,
  onToggleCollapse,
  children,
}: WorktreeCardGroupProps) {
  return (
    <div>
      {/* Section header */}
      <button
        className={cn(
          "w-full flex items-center gap-2 px-2 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:bg-muted/10 transition-colors",
        )}
        onClick={onToggleCollapse}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>
          {groupKey} ({count})
        </span>
      </button>

      {/* Card grid */}
      {!isCollapsed && (
        <div className="flex flex-wrap gap-3 px-2 pb-3">{children}</div>
      )}
    </div>
  );
}
