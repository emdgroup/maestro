import { cn } from "@/lib/utils";

/**
 * A project's count of something, `3 running`: the number in `className` when there is any, and
 * faded at zero. `large` is the Home tile's size; the header menu uses the default.
 */
export function Count({
  value,
  label,
  className,
  large = false,
}: {
  value: number;
  label: string;
  className?: string;
  large?: boolean;
}) {
  return (
    <span className={cn("items-baseline gap-1", large ? "flex" : "inline-flex")}>
      <span
        className={cn(
          "font-semibold tabular-nums",
          large && "text-base",
          value ? className : "text-muted-foreground/50",
        )}
      >
        {value}
      </span>
      <span className={cn("text-muted-foreground", large && "text-[11px]")}>{label}</span>
    </span>
  );
}
