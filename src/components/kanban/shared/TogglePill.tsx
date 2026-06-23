import type { ReactNode } from "react";
import { cn } from "@/lib/ui-utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/ui/tooltip";

export const PILL =
  "flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-xs transition-colors";

export const POPOVER_ITEM =
  "flex items-center gap-2 w-full px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors";

interface TogglePillProps {
  value: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  icon: ReactNode;
  activeIcon?: ReactNode;
  tooltip?: string;
}

export function TogglePill({ value, onChange, label, icon, activeIcon, tooltip }: TogglePillProps) {
  const readonly = onChange === undefined;
  const button = readonly ? (
    <span
      className={cn(
        PILL,
        value ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-muted-foreground",
        "cursor-default",
      )}
    >
      {value && activeIcon ? activeIcon : icon}
      {label}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(
        PILL,
        value
          ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
          : "border-border bg-transparent text-muted-foreground hover:bg-muted",
      )}
    >
      {value && activeIcon ? activeIcon : icon}
      {label}
    </button>
  );

  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
