import { cn } from "@/lib/utils";
import { SegmentThumb } from "@/components/common/SegmentThumb";

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
}

/** Home's segmented switch: the SSH sign-in method, the clone source. */
export function Segmented<T extends string>({ value, onChange, options }: SegmentedProps<T>) {
  return (
    <div
      className="relative grid gap-1 rounded-xl border border-foreground/10 bg-background/45 p-1 text-xs"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <SegmentThumb />
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "relative h-8 cursor-pointer rounded-lg",
            value === option ? "font-medium" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
