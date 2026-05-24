import type { TaskPriority } from "@/types/bindings";

export const PRIORITY_BADGE_CLASSES: Record<TaskPriority, string> = {
  Urgent: "bg-destructive/15 text-destructive border border-destructive/30",
  High: "bg-amber-100 text-amber-700 border border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  Medium: "bg-accent/15 text-accent-foreground border border-accent/30",
  Low: "bg-muted text-muted-foreground border border-border",
  None: "bg-muted/50 text-muted-foreground/60 border border-border/50",
};
