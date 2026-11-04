import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SEGMENT_GROUP, SEGMENT_ITEM } from "@/lib/segmented";
import { SegmentThumb } from "@/components/common/SegmentThumb";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";

export interface SegmentedOption<T extends string> {
  value: T;
  /** Text, an icon, or both: `<><Repeat className="size-3" />Loops</>`. */
  label: ReactNode;
  /** Needed when the label is an icon alone. */
  ariaLabel?: string;
}

const ITEM_SIZE = {
  /** Dialog headers: `Form | JSON`. */
  xs: "h-5 px-2 text-[11px]",
  /** Toolbars and filters, the default. */
  sm: "",
  /** Home's forms: full width, equal segments, taller, and only the chosen one bold. */
  lg: "h-8 flex-1 cursor-pointer font-normal aria-pressed:font-medium",
};

/**
 * A single choice out of a few: a translucent track with `SegmentThumb` sliding under the chosen
 * option. Pressing the chosen option again keeps it chosen.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "sm",
  className,
  itemClassName,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** The group's accessible name. */
  label?: string;
  size?: keyof typeof ITEM_SIZE;
  className?: string;
  itemClassName?: string;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        const next = values.find((option) => option !== value) as T | undefined;
        if (next) onChange(next);
      }}
      spacing={1}
      className={cn(SEGMENT_GROUP, size === "lg" && "flex w-full p-1", className)}
    >
      <SegmentThumb />
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          size="sm"
          aria-label={option.ariaLabel}
          className={cn(SEGMENT_ITEM, ITEM_SIZE[size], itemClassName)}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
