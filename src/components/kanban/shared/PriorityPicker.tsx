import { Check, Flame, ArrowUp, Minus, ArrowDown, CircleSlash } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { PILL, POPOVER_ITEM } from "./TogglePill";
import { PRIORITIES } from "@/utils/constants/priority";
import type { TaskPriority } from "@/types/bindings";

interface PriorityPickerProps {
  value: TaskPriority;
  onChange?: (p: TaskPriority) => void;
}

function PriorityIcon({ priority }: { priority: TaskPriority }) {
  if (priority === "Urgent")
    return <Flame className="size-3 shrink-0 fill-current text-[oklch(68%_0.2_25)]" />;
  if (priority === "High") return <ArrowUp className="size-3 shrink-0 text-[oklch(72%_0.18_55)]" />;
  if (priority === "Medium") return <Minus className="size-3 shrink-0 text-muted-foreground" />;
  if (priority === "Low") return <ArrowDown className="size-3 shrink-0 text-success" />;
  return <CircleSlash className="size-3 shrink-0 text-muted-foreground" />;
}

export function PriorityPicker({ value, onChange }: PriorityPickerProps) {
  if (!onChange) {
    return (
      <span className={cn(PILL, "border-border text-muted-foreground cursor-default")}>
        <PriorityIcon priority={value} />
        {value}
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        className={cn(PILL, "border-border bg-transparent text-muted-foreground hover:bg-muted")}
      >
        <PriorityIcon priority={value} />
        {value}
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1 gap-0" align="start">
        {PRIORITIES.map((p) => (
          <button key={p} type="button" onClick={() => onChange(p)} className={POPOVER_ITEM}>
            <PriorityIcon priority={p} />
            {p}
            {value === p && <Check className="size-3 ml-auto" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
