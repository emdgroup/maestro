import { ChevronDown } from "lucide-react";
import { Reveal } from "@/components/common/Reveal";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils";

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
      <Button
        variant="ghost"
        onClick={onToggleCollapse}
        className="w-full flex items-center gap-2 px-2 py-2 h-auto text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:bg-foreground/7 transition-colors justify-start"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            isCollapsed && "-rotate-90",
          )}
        />
        <span>
          {groupKey} ({count})
        </span>
      </Button>

      {/* Card grid */}
      <Reveal open={!isCollapsed}>
        <div className="flex flex-wrap gap-3 px-2 pb-3">{children}</div>
      </Reveal>
    </div>
  );
}
