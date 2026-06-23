import { Check } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { PILL, POPOVER_ITEM } from "./TogglePill";
import { PRIORITY_COLORS, PRIORITIES } from "@/utils/constants/priority";
import type { TaskPriority } from "@/types/bindings";

interface PriorityPickerProps {
  value: TaskPriority;
  onChange?: (p: TaskPriority) => void;
}

export function PriorityPicker({ value, onChange }: PriorityPickerProps) {
  if (!onChange) {
    return (
      <span className={cn(PILL, "border-border text-muted-foreground cursor-default")}>
        <span
          className="size-2 rounded-full shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[value] }}
        />
        {value}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        className={cn(PILL, "border-border bg-transparent text-muted-foreground hover:bg-muted")}
      >
        <span
          className="size-2 rounded-full shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[value] }}
        />
        {value}
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        {PRIORITIES.map((p) => (
          <button key={p} type="button" onClick={() => onChange(p)} className={POPOVER_ITEM}>
            <span
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: PRIORITY_COLORS[p] }}
            />
            {p}
            {value === p && <Check className="size-3 ml-auto" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
