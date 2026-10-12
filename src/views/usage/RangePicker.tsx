import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "@/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { cn } from "@/lib/utils";
import { PRESETS, rangeTitle, type RangeChoice } from "./range";

interface RangePickerProps {
  choice: RangeChoice;
  onChange: (choice: RangeChoice) => void;
}

/**
 * The range part of the title: presets on the left apply at once, two months of calendar on the
 * right pick a custom range that `Apply` applies.
 */
export function RangePicker({ choice, onChange }: RangePickerProps) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<DateRange | undefined>(undefined);

  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) setDays("from" in choice ? { from: choice.from, to: choice.to } : undefined);
  };

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger className="cursor-pointer text-accent underline decoration-dotted underline-offset-4">
        {rangeTitle(choice)} ▾
      </PopoverTrigger>
      <PopoverContent align="start" className="home-pop w-auto flex-row gap-4 rounded-2xl p-3">
        <div className="flex w-44 flex-col border-r border-foreground/10 pr-3">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                onChange({ preset: preset.id });
                setOpen(false);
              }}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-foreground/5",
                "preset" in choice && choice.preset === preset.id && "bg-accent/15",
              )}
            >
              {preset.label}
            </button>
          ))}
          <div className="my-1 border-t border-foreground/10" />
          <div
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[13px]",
              "from" in choice && "bg-accent/15",
            )}
          >
            Custom <span className="text-[11px] text-muted-foreground">pick days</span>
          </div>
        </div>
        <div
          style={
            {
              "--primary": "var(--accent)",
              "--primary-foreground": "var(--accent-foreground)",
            } as React.CSSProperties
          }
        >
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={days}
            onSelect={setDays}
            disabled={{ after: new Date() }}
            className="bg-transparent p-0"
          />
          <div className="mt-3 flex justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg px-3 py-1.5 hover:bg-foreground/5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!days?.from}
              onClick={() => {
                if (!days?.from) return;
                onChange({ from: days.from, to: days.to ?? days.from });
                setOpen(false);
              }}
              className="rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
