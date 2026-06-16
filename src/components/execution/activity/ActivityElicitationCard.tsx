import { useState } from "react";
import { MessageCircleQuestionMark, ChevronDown } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import type { ElicitationSummaryItem } from "./types";

interface Props {
  item: ElicitationSummaryItem;
}

export function ActivityElicitationCard({ item }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (item.declined) {
    return (
      <div className="border border-border rounded-lg bg-card px-3 py-2 flex items-center gap-2">
        <MessageCircleQuestionMark className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground flex-1 truncate">{item.message}</span>
        <span className="text-xs text-muted-foreground italic">Declined</span>
      </div>
    );
  }

  const answeredCount = item.fields.filter((f) => f.answer && f.answer.length > 0).length;
  const total = item.fields.length;

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <MessageCircleQuestionMark className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-medium text-foreground flex-1 truncate">{item.message}</span>
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {answeredCount} / {total} answered
        </span>
        <ChevronDown
          className={cn(
            "w-3 h-3 text-muted-foreground transition-transform duration-200 shrink-0",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {item.fields.map((f) => (
            <div key={f.key} className="px-3 py-1.5 flex gap-2">
              <span className="text-xs text-muted-foreground min-w-0 truncate shrink-0 basis-1/3">
                {f.question}
              </span>
              {f.answer.map((answer) => (
                <code className="text-xs text-foreground min-w-0 bg-muted/60 rounded px-1 py-0.5 font-mono break-all">
                  {answer}
                </code>
              ))}

            </div>
          ))}
        </div>
      )}
    </div>
  );
}
