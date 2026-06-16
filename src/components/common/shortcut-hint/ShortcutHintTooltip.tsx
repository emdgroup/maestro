import { Kbd } from "@/ui/kbd";

interface ShortcutHintTooltipProps {
  keyLabel: string;
  placement?: "above" | "below";
}

export function ShortcutHintTooltip({ keyLabel, placement = "below" }: ShortcutHintTooltipProps) {
  const isAbove = placement === "above";
  return (
    <span
      className={`absolute left-1/2 -translate-x-1/2 pointer-events-none z-50 flex flex-col items-center animate-in zoom-in-95 fade-in duration-150 ${
        isAbove ? "bottom-full mb-1.5" : "top-full mt-1.5"
      }`}
    >
      {!isAbove && <span className="border-4 border-transparent border-b-accent" />}
      <Kbd className="bg-accent text-accent-foreground shadow-md text-[10px] h-[18px] min-w-[18px] whitespace-nowrap">
        {keyLabel}
      </Kbd>
      {isAbove && <span className="border-4 border-transparent border-t-accent" />}
    </span>
  );
}
