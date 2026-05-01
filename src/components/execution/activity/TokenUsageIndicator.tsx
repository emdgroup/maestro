import { humanizeTokenCount } from "@/lib";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";
import { UsageState } from "./types";

interface TokenUsageIndicatorProps {
  usage: UsageState;
}

export function TokenUsageIndicator({ usage }: TokenUsageIndicatorProps) {
  const circumference = 2 * Math.PI * 6;
  const ratio = Math.min(1, Math.max(0, usage.used / usage.size));
  const dashOffset = circumference * (1 - ratio);
  const colorClass = ratio >= 0.85 ? "text-red-500" : ratio >= 0.6 ? "text-amber-500" : "text-emerald-500";

  const formatCost = (amount: number, currency: string) => {
    const decimals = amount < 0.01 ? 4 : 2;
    return `${amount.toFixed(decimals)} ${currency}`;
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <div className="relative h-4 w-4 cursor-help">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              style={{ transform: "rotate(-90deg)" }}
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="var(--border)"
                strokeWidth="2"
                fill="none"
              />
              <circle
                cx="8"
                cy="8"
                r="6"
                strokeWidth="2"
                fill="none"
                stroke="currentColor"
                strokeDasharray={`${circumference}`}
                strokeDashoffset={`${dashOffset}`}
                strokeLinecap="round"
                className={colorClass}
              />
            </svg>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-0.5">
            <span>
              {Math.round(ratio * 100)}% · {humanizeTokenCount(usage.used)} /{" "}
              {humanizeTokenCount(usage.size)}
            </span>
            {usage.cost !== null && (
              <span>{formatCost(usage.cost.amount, usage.cost.currency)}</span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
