import { cn } from "@/lib/utils";

/** One choice out of a few, each a card with a line saying what it does; the picked one is lit. */
export function ChoiceCards<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: { value: T; label: string; hint: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-1.5">
      {label && <div className="text-xs font-medium">{label}</div>}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-md border p-2 text-left transition-colors hover:bg-muted/50",
            option.value === value &&
              "border-accent bg-accent/10 ring-1 ring-accent hover:bg-accent/10",
          )}
        >
          <div className="text-sm font-medium">{option.label}</div>
          <div className="text-xs text-muted-foreground">{option.hint}</div>
        </button>
      ))}
    </div>
  );
}
