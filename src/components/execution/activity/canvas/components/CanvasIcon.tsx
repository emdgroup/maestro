import { icons } from "lucide-react";
import { cn } from "@/lib/utils.ts";

interface Props {
  name?: string;
  size?: number;
  className?: string;
  [key: string]: unknown;
}

export function CanvasIcon({ name, size = 16, className }: Props) {
  if (!name) return null;
  const pascalName = name
    .split(/[-_\s]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("") as keyof typeof icons;
  const LucideIcon = icons[pascalName];
  if (!LucideIcon) {
    return <span className={cn("text-xs text-muted-foreground", className)}>[{name}]</span>;
  }
  return <LucideIcon size={size} className={cn("shrink-0", className)} />;
}
