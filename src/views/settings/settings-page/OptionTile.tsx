import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface OptionTileProps {
  selected: boolean;
  onSelect: () => void;
  className?: string;
  children: React.ReactNode;
}

/**
 * One choice in a grid of them — the settings pages' alternative to a two- or three-option select,
 * where the options are worth showing rather than reading.
 *
 * Only the frame is shared: the border, the selected state and the check badge. What goes inside
 * is the caller's, because a tile carrying an icon over a label and one carrying a list of key
 * bindings agree on nothing else.
 */
export function OptionTile({ selected, onSelect, className, children }: OptionTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "relative rounded-md border p-3 transition-colors cursor-pointer",
        selected
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
        className,
      )}
    >
      {selected && (
        <div className="absolute top-1.5 right-1.5 rounded-full bg-accent p-0.5">
          <Check className="w-2.5 h-2.5 text-accent-foreground" />
        </div>
      )}
      {children}
    </button>
  );
}
