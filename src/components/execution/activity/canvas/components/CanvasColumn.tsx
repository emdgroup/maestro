import { cn } from "@/lib/utils.ts";
import type { ReactNode } from "react";

interface Props {
  children?: ReactNode;
  gap?: number;
  className?: string;
  [key: string]: unknown;
}

export function CanvasColumn({ children, gap = 3, className }: Props) {
  return <div className={cn("flex flex-col", `gap-${gap}`, className)}>{children}</div>;
}
