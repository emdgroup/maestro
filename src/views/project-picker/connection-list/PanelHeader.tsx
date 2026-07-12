import { ChevronLeft } from "lucide-react";

export function PanelHeader({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
      <button
        type="button"
        onClick={onBack}
        className="p-1 -ml-1 rounded hover:bg-muted/50 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-sm font-medium">{title}</span>
    </div>
  );
}
