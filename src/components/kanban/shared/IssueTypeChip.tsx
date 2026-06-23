import {
  Bug,
  BookOpen,
  Zap,
  CheckSquare,
  Sparkles,
  TrendingUp,
  AlertTriangle,
  FlaskConical,
  CircleDot,
  X,
} from "lucide-react";

const ICONS: Record<string, React.ReactNode> = {
  bug: <Bug className="size-3" />,
  story: <BookOpen className="size-3" />,
  "user story": <BookOpen className="size-3" />,
  epic: <Zap className="size-3" />,
  task: <CheckSquare className="size-3" />,
  "product backlog item": <CheckSquare className="size-3" />,
  feature: <Sparkles className="size-3" />,
  improvement: <TrendingUp className="size-3" />,
  incident: <AlertTriangle className="size-3" />,
  test: <FlaskConical className="size-3" />,
  "test case": <FlaskConical className="size-3" />,
};

const COLORS: Record<string, string> = {
  bug: "bg-red-500/15 text-red-400",
  story: "bg-blue-500/15 text-blue-400",
  "user story": "bg-blue-500/15 text-blue-400",
  epic: "bg-purple-500/15 text-purple-400",
  task: "bg-green-500/15 text-green-400",
  "product backlog item": "bg-green-500/15 text-green-400",
  feature: "bg-amber-500/15 text-amber-400",
  improvement: "bg-teal-500/15 text-teal-400",
  incident: "bg-orange-500/15 text-orange-400",
  test: "bg-violet-500/15 text-violet-400",
  "test case": "bg-violet-500/15 text-violet-400",
};

export function IssueTypeChip({ type, onRemove }: { type: string; onRemove?: () => void }) {
  const key = type.toLowerCase();
  const icon = ICONS[key] ?? <CircleDot className="size-3" />;
  const color = COLORS[key] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[11px] leading-none ${color}`}
    >
      {icon}
      {type}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-0.5 opacity-60 hover:opacity-100 leading-none"
          aria-label={`Remove ${type}`}
        >
          <X className="size-2.5" />
        </button>
      )}
    </span>
  );
}
