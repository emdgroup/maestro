import type { ReactNode } from "react";

interface Props {
  children?: ReactNode;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export function CanvasCardComponent({ children, title, description }: Props) {
  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col gap-1.5">
      {title && <div className="text-xs font-medium text-muted-foreground">{title}</div>}
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
      {children}
    </div>
  );
}
