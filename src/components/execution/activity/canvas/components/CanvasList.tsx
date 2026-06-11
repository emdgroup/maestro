import { cn } from "@/lib/ui-utils";
import type { CanvasSurface } from "../../types";
import { CanvasComponentNode } from "../CanvasRenderer";

interface ListItem {
  text?: string;
  childId?: string;
}

interface Props {
  items?: ListItem[];
  ordered?: boolean;
  surface: CanvasSurface;
  depth: number;
  className?: string;
  [key: string]: unknown;
}

export function CanvasList({ items = [], ordered = false, surface, depth, className }: Props) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className={cn("text-sm space-y-1", ordered ? "list-decimal pl-5" : "list-disc pl-5", className)}>
      {items.map((item, i) => (
        <li key={i}>
          {item.childId ? (
            <CanvasComponentNode surface={surface} componentId={item.childId} depth={depth + 1} />
          ) : (
            item.text
          )}
        </li>
      ))}
    </Tag>
  );
}
