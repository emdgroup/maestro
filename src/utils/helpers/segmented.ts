/**
 * Home's `Segmented` switch (src/views/home/Segmented.tsx) for the shadcn primitives the views
 * use: a translucent track with a raised segment for the chosen option, which is `SegmentThumb`
 * and has to be rendered inside each group.
 */

/** For `TabsList` and `TabsTrigger`. */
export const SEGMENT_LIST =
  "relative h-auto gap-1 rounded-xl border border-foreground/10 bg-background/45 p-[3px]";
export const SEGMENT_TRIGGER =
  "relative h-auto rounded-lg px-3 py-1 text-xs text-muted-foreground data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent";

/** For a `ToggleGroup` with `spacing={1}`, and its `ToggleGroupItem`s. */
export const SEGMENT_GROUP =
  "relative rounded-xl border border-foreground/10 bg-background/45 p-[3px]";
export const SEGMENT_ITEM =
  "relative h-6 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-transparent aria-pressed:bg-transparent aria-pressed:text-foreground";
