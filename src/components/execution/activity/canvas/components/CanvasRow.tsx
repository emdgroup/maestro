import { cn } from "@/lib/ui-utils";
import type { ReactNode } from "react";

interface Props {
  children?: ReactNode;
  gap?: number;
  wrap?: boolean;
  align?: "start" | "center" | "end" | "stretch";
  equalWidth?: boolean;
  className?: string;
  [key: string]: unknown;
}

export function CanvasRow({
  children,
  gap = 3,
  wrap = false,
  align = "start",
  equalWidth = true,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "flex flex-row",
        `gap-${gap}`,
        wrap && "flex-wrap",
        equalWidth && "[&>*]:flex-1 [&>*]:min-w-0",
        align === "center" && "items-center",
        align === "end" && "items-end",
        align === "stretch" && "items-stretch",
        align === "start" && "items-start",
        className,
      )}
    >
      {children}
    </div>
  );
}
