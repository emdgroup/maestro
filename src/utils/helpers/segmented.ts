/**
 * Home's `Segmented` switch (src/views/home/Segmented.tsx) for the shadcn primitives the views
 * use: a translucent track with a raised segment for the chosen option.
 */

/** For `TabsList` and `TabsTrigger`. */
export const SEGMENT_LIST =
  "h-auto gap-1 rounded-xl border border-foreground/10 bg-background/45 p-[3px]";
export const SEGMENT_TRIGGER =
  "h-auto rounded-lg px-3 py-1 text-xs text-muted-foreground data-active:bg-card/90 data-active:text-foreground data-active:shadow-sm dark:data-active:border-transparent dark:data-active:bg-card/90";

/** For a `ToggleGroup` with `spacing={1}`, and its `ToggleGroupItem`s. */
export const SEGMENT_GROUP = "rounded-xl border border-foreground/10 bg-background/45 p-[3px]";
export const SEGMENT_ITEM =
  "h-6 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-transparent aria-pressed:bg-card/90 aria-pressed:text-foreground aria-pressed:shadow-sm";
