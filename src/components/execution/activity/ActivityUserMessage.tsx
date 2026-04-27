import { GitFork, CornerUpLeft, RotateCcw } from "lucide-react";
import type { UserMessageItem } from "./types";

interface ActivityUserMessageProps {
  message: UserMessageItem;
}

export function ActivityUserMessage({ message }: ActivityUserMessageProps) {
  return (
    <div className="flex items-start gap-2.5 group">
      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        M
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
          {message.content}
        </div>
        <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
            title="Fork session from here"
          >
            <GitFork className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
            title="Rewind discussion"
          >
            <CornerUpLeft className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
            title="Rewind everything"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
