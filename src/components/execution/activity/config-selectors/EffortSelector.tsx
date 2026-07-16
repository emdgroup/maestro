import { useState } from "react";
import { Dumbbell } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { cn } from "@/lib/utils.ts";
import type { SelectorProps } from "./BaseDropdownSelector";

export function EffortSelector({ option, value, onChange, disabled }: SelectorProps) {
  const options = option.options.filter((o) => o.value !== "default");
  const currentIdx = options.findIndex((o) => o.value === value);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const displayIdx = hoveredIdx ?? currentIdx;
  const n = options.length;

  const displayName = options[displayIdx]?.name ?? value;

  function barHeight(i: number): number {
    if (n <= 1) return 14;
    return Math.round(5 + (8 * i) / (n - 1));
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "group inline-flex items-center gap-1 py-0.5 pl-1.5 pr-1.5 text-[11px] rounded border border-transparent",
              "text-muted-foreground hover:border-border hover:bg-muted/50 transition-colors select-none",
              disabled ? "opacity-40 cursor-not-allowed" : "cursor-default",
            )}
          />
        }
      >
        <Dumbbell className="size-3 shrink-0" />

        {/* Growing bars — slide in on hover */}
        <div className="flex items-end gap-0.5 overflow-hidden max-w-0 group-hover:max-w-20 transition-[max-width] duration-200 ease-out ml-0.5">
          {options.map((opt, i) => {
            const filled = i <= displayIdx;
            const height = barHeight(i);
            return (
              <Tooltip key={opt.value}>
                <TooltipTrigger
                  type="button"
                  disabled={disabled}
                  onClick={() => !disabled && onChange(opt.value)}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  style={{ height: `${height}px` }}
                  className={cn(
                    "w-1.25 rounded-[3px] shrink-0 transition origin-bottom",
                    filled ? "bg-accent/80" : "bg-muted-foreground/20",
                    !disabled &&
                      i === displayIdx &&
                      "hover:bg-accent hover:scale-x-125 cursor-pointer",
                  )}
                />
                <TooltipContent>{opt.name}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <span>{displayName}</span>
      </TooltipTrigger>

      {option.description && (
        <TooltipContent side="top" sideOffset={6}>
          {option.description}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
