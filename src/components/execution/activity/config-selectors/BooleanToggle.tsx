import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { TRIGGER_CLASS } from "./BaseDropdownSelector";
import type { SelectorProps } from "./BaseDropdownSelector";

/** An on/off config option (Claude's Fast mode): one click flips it. */
export function BooleanToggle({ option, value, onChange, disabled }: SelectorProps) {
  const on = value === "true";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center" />}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={option.name}
          disabled={disabled}
          onClick={() => onChange(on ? "false" : "true")}
          className={cn(TRIGGER_CLASS, "gap-1.5", on && "text-accent")}
        >
          <span>{option.name}</span>
          <span
            className={cn(
              "relative inline-block h-3 w-5 rounded-full transition-colors",
              on ? "bg-accent" : "bg-foreground/15",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-2 rounded-full bg-background transition-[left]",
                on ? "left-2.5" : "left-0.5",
              )}
            />
          </span>
        </button>
      </TooltipTrigger>
      {option.description && (
        <TooltipContent side="top" sideOffset={6}>
          {option.description}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
