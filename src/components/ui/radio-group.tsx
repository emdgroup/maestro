"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  tone = "primary",
  ...props
}: RadioPrimitive.Root.Props & {
  /**
   * Which colour marks the selected state. `accent` follows the user's chosen hue and is what
   * Settings uses; see `Switch`. A prop rather than a `className` override because the dot is an
   * internal element the caller cannot reach.
   */
  tone?: "primary" | "accent";
}) {
  const accent = tone === "accent";
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        // `border-border`, not `border-input`, for the reason spelled out on Checkbox: --input is
        // a fill colour, and an unselected radio is nothing but its border. On a card that left it
        // invisible until selected, so a two-option group read as one option and a label.
        "group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-border outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        accent
          ? "data-checked:border-accent data-checked:bg-accent data-checked:text-accent-foreground dark:data-checked:bg-accent"
          : "data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="flex size-4 items-center justify-center"
      >
        <span
          className={cn(
            "absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full",
            accent ? "bg-accent-foreground" : "bg-primary-foreground",
          )}
        />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
