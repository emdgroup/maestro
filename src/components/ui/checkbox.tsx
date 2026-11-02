"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "@/lib/utils";
import { MinusIcon } from "lucide-react";

function Checkbox({ className, indeterminate, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      indeterminate={indeterminate}
      className={cn(
        // `border-border`, not `border-input`: --input is a fill colour, and an unchecked box is
        // nothing but its border. Against a card or popover --input is oklch(99%) on 98% in light
        // and the very same value in dark, so the box was invisible until it was ticked.
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-lg border border-border shadow-xs transition-[background-color,border-color,box-shadow,scale] duration-150 outline-none active:scale-90 group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-accent dark:data-checked:bg-accent data-checked:text-accent-foreground data-checked:border-accent data-indeterminate:bg-accent dark:data-indeterminate:bg-accent data-indeterminate:border-accent data-indeterminate:text-accent-foreground",
        className,
      )}
      {...props}
    >
      {/* Kept mounted so the tick is drawn by a transition, which a box already ticked when it
          first renders does not play. */}
      <CheckboxPrimitive.Indicator
        keepMounted
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current [&>svg]:size-3.5"
      >
        {indeterminate ? (
          <MinusIcon />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d="M4 12l5 5L20 6"
              className="[stroke-dasharray:24] [stroke-dashoffset:24] transition-[stroke-dashoffset] duration-100 in-data-checked:[stroke-dashoffset:0] in-data-checked:delay-40 in-data-checked:duration-220 in-data-checked:ease-out"
            />
          </svg>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
