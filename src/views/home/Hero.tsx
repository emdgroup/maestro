import { cn } from "@/lib/utils";

interface HeroProps {
  working: number;
  needYou: number;
  toReview: number;
}

/** The logo and name on the left, the three numbers that matter across every connection on the right. */
export function Hero({ working, needYou, toReview }: HeroProps) {
  const scores = [
    { value: working, label: "working", className: "home-working" },
    { value: needYou, label: "need you", className: "text-amber-600 dark:text-amber-400" },
    { value: toReview, label: "to review", className: "home-review" },
  ];
  return (
    <section className="mb-12 flex items-end gap-12">
      <div className="flex items-center gap-4">
        <img src="/maestro-logo.png" alt="" className="home-logo size-16 object-contain" />
        <div>
          <h1 className="text-[28px] leading-none font-semibold tracking-[-0.025em]">Maestro</h1>
          <div className="mt-1.5 text-xs text-muted-foreground">Conduct your agents in concert</div>
        </div>
      </div>
      <div className="ml-auto flex gap-10">
        {scores.map((score) => (
          <div key={score.label}>
            <div
              className={cn(
                "text-[52px] leading-none font-semibold tracking-[-0.025em] tabular-nums",
                score.value ? score.className : "text-muted-foreground/40",
              )}
            >
              {score.value}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{score.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
