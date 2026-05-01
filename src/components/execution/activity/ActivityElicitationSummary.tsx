import type { ElicitationSummaryItem } from "./types";

interface Props {
  item: ElicitationSummaryItem;
}

export function ActivityElicitationSummary({ item }: Props) {
  return (
    <div className="text-xs text-sky-400/80 px-1">
      <span className="font-medium">{item.question}</span>
      <span className="text-sky-400/50 mx-1">→</span>
      <span>{item.answer}</span>
    </div>
  );
}
