import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/ui/button";
import { Separator } from "@/ui/separator";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Calendar } from "@/ui/calendar";
import type { Preset } from "./useSessionHistory";

interface Props {
  preset: Preset;
  onPresetChange: (p: Preset) => void;
  customRange: DateRange;
  onCustomRangeChange: (r: DateRange) => void;
  stagingRange: DateRange;
  onStagingRangeChange: (r: DateRange) => void;
  calendarOpen: boolean;
  onCalendarOpenChange: (open: boolean) => void;
}

const PRESET_LABELS: Record<Exclude<Preset, "custom">, string> = {
  all: "All sessions",
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export function SessionHistorySidebar({
  preset,
  onPresetChange,
  customRange,
  onCustomRangeChange,
  stagingRange,
  onStagingRangeChange,
  calendarOpen,
  onCalendarOpenChange,
}: Props) {
  return (
    <div className="w-44 border-r border-border flex flex-col shrink-0 py-2">
      <div className="flex flex-col gap-0.5 px-2">
        {(Object.keys(PRESET_LABELS) as Exclude<Preset, "custom">[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPresetChange(p)}
            className={cn(
              "w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors",
              preset === p
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      <Separator className="my-2" />

      <div className="px-2 flex flex-col gap-2">
        <p className="text-[10px] text-muted-foreground/70 px-0.5">Custom range</p>
        <Popover
          open={calendarOpen}
          onOpenChange={(open) => {
            if (!open) onStagingRangeChange(customRange);
            onCalendarOpenChange(open);
          }}
        >
          <div className="flex items-center gap-1">
            <PopoverTrigger
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "h-7 text-xs flex-1 justify-start font-normal",
                preset === "custom" && "border-primary/50",
              )}
            >
              {stagingRange.from
                ? `${format(stagingRange.from, "MMM d")}${stagingRange.to ? ` – ${format(stagingRange.to, "MMM d")}` : " –"}`
                : "Pick dates"}
            </PopoverTrigger>
            {preset === "custom" && customRange.from && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0 h-7 w-7"
                onClick={() => {
                  onStagingRangeChange({ from: undefined });
                  onCustomRangeChange({ from: undefined });
                  onPresetChange("all");
                }}
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
          <PopoverContent className="w-auto p-0" side="right" align="start">
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
                selected={stagingRange}
                onSelect={(range) => onStagingRangeChange(range ?? { from: undefined })}
                disabled={{ after: new Date() }}
                numberOfMonths={1}
              />
            </div>
            <div className="flex justify-between px-3 pb-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={!stagingRange.from && !customRange.from}
                onClick={() => {
                  onStagingRangeChange({ from: undefined });
                  onCustomRangeChange({ from: undefined });
                  onPresetChange("all");
                  onCalendarOpenChange(false);
                }}
              >
                Clear
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!stagingRange.from}
                onClick={() => {
                  onCustomRangeChange(stagingRange);
                  onPresetChange("custom");
                  onCalendarOpenChange(false);
                }}
              >
                Apply
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
