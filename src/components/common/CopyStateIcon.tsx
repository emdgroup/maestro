import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The icon for a copy control: Copy, then a Check drawing itself in while `copied` holds. Both are
 * always mounted so the swap animates each way; `.copy-state` in `index.css` drives it, and
 * `className` sizes the box.
 */
export function CopyStateIcon({ copied, className }: { copied: boolean; className?: string }) {
  return (
    <span data-copied={copied} className={cn("copy-state grid shrink-0", className)}>
      <Copy className="size-full" />
      <Check className="size-full text-success" />
    </span>
  );
}
