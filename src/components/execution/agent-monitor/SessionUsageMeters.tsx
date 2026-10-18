import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { humanizeTokenCount } from "@/lib/format-utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  DOT_COLOR,
  PCT_COLOR,
  PROGRESS_COLOR,
} from "@/components/execution/activity/liquid-indicator-data";
import { getLifecycle, subscribeSession } from "@/components/execution/activity/sessionRuntime";
import {
  PLAN_WINDOWS,
  elapsedShare,
  formatCountdown,
  liveWindows,
  planLimitsKey,
  usePlanLimitsStore,
  windowTone,
  type PlanLimits,
  type PlanWindowId,
  type WindowTone,
} from "@/components/execution/activity/planLimits";
import { useSessionUsageQuery } from "@/services/execution.service";
import { connectionKeyId } from "@/store/homeStore";
import type { ConnectionKey, UsageTurn } from "@/types/bindings";

/** The context window popover's colours, so both popups speak one language. */
const STATE = { ok: "normal", ahead: "amber", reached: "critical" } as const;
const TEXT: Record<WindowTone, string> = {
  ok: "text-foreground",
  ahead: "text-warning",
  reached: "text-destructive",
};
/** What is left of the window: it shrinks toward the reset, and a fill running into it is ahead of pace. */
const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, color-mix(in oklab, var(--foreground) 16%, transparent) 0 2px, transparent 2px 4px)",
};
const OVERAGE_REASON: Record<string, string> = {
  org_level_disabled: "disabled by your organisation",
  org_level_disabled_until: "disabled by your organisation",
  out_of_credits: "out of credits",
  overage_not_provisioned: "not set up on this plan",
};
const CARD = cn(
  "flex w-64 flex-col gap-3 rounded-md p-3.5 text-[11px]",
  "backdrop-blur-[4px] bg-popover/60 border-border/30",
  "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_-1px_0_0_rgba(0,0,0,0.15)]",
);

type TokenKind = "cacheRead" | "cacheWrite" | "input" | "thought" | "output";
const TOKEN_KINDS: { kind: TokenKind; label: string; color: string; field: keyof UsageTurn }[] = [
  { kind: "cacheRead", label: "Cache read", color: "bg-chart-2", field: "cached_read_tokens" },
  { kind: "cacheWrite", label: "Cache write", color: "bg-chart-4", field: "cached_write_tokens" },
  { kind: "input", label: "Input", color: "bg-chart-1", field: "input_tokens" },
  { kind: "thought", label: "Thinking", color: "bg-chart-5", field: "thought_tokens" },
  { kind: "output", label: "Output", color: "bg-chart-3", field: "output_tokens" },
];
/** One neutral hue told apart by pattern, so a model never reads as one of the token kinds. */
const MODEL_FILL = [
  "var(--muted-foreground)",
  "repeating-linear-gradient(135deg, var(--muted-foreground) 0 2px, color-mix(in oklab, var(--muted-foreground) 30%, transparent) 2px 4px)",
  "color-mix(in oklab, var(--muted-foreground) 40%, transparent)",
  "repeating-linear-gradient(90deg, var(--muted-foreground) 0 1px, color-mix(in oklab, var(--muted-foreground) 25%, transparent) 1px 3px)",
];
// ponytail: only the latest turns get a bar; past this they would be thinner than their gaps.
const MAX_BARS = 60;
const UNKNOWN_MODEL = "Unknown model";

function Track({
  usage,
  elapsed,
  tone,
  className,
}: {
  usage: number;
  elapsed: number;
  tone: WindowTone;
  className: string;
}) {
  return (
    <div className={cn("relative overflow-hidden rounded-full bg-foreground/[0.07]", className)}>
      <div
        className="absolute inset-y-0 right-0"
        style={{ ...HATCH, width: `${(1 - elapsed) * 100}%` }}
      />
      <div
        className={cn("absolute inset-y-0 left-0 rounded-full", PROGRESS_COLOR[STATE[tone]])}
        style={{ width: `${Math.min(usage, 1) * 100}%` }}
      />
    </div>
  );
}

function money({ amount, currency }: { amount: number; currency: string }) {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * A turn's tokens by kind. Some agents count cache reads inside `input_tokens` and some do not: a
 * total smaller than every count added up says this one does, and its input is what is left.
 */
export function tokensOf(t: UsageTurn): Record<TokenKind, number> {
  const read = t.cached_read_tokens ?? 0;
  const write = t.cached_write_tokens ?? 0;
  const input = t.input_tokens ?? 0;
  const output = t.output_tokens ?? 0;
  const thought = t.thought_tokens ?? 0;
  const inclusive =
    read > 0 && input >= read && input + output + thought + read + write > (t.total_tokens ?? 0);
  return {
    cacheRead: read,
    cacheWrite: write,
    input: inclusive ? input - read : input,
    thought,
    output,
  };
}

/**
 * The session's cost and tokens, then its agent's 5-hour window, on the right of the session
 * header, each with its own hover card. A window is labelled with the time left before it resets,
 * and its track hatches what is left of it.
 */
export function SessionUsageMeters({
  sessionId,
  acpSessionId,
  agentId,
  connection,
}: {
  sessionId: string;
  acpSessionId: string | null;
  agentId: string | null;
  connection: ConnectionKey;
}) {
  const connectionId = connectionKeyId(connection);
  const subscribe = useCallback((fn: () => void) => subscribeSession(sessionId, fn), [sessionId]);
  const cost = useSyncExternalStore(subscribe, () => getLifecycle(sessionId).usageState?.cost);
  const limits = usePlanLimitsStore((s) =>
    agentId ? s.byAgent[planLimitsKey(connectionId, agentId)] : undefined,
  );
  const { data: turns } = useSessionUsageQuery(connection, agentId, acpSessionId, sessionId);
  // A turn the agent reported no tokens for still happened, but has nothing to add up.
  const measured = (turns ?? []).filter((t) => t.total_tokens != null);
  const total = measured.reduce((sum, t) => sum + (t.total_tokens ?? 0), 0);

  // Ticks whether or not a reading has arrived, so the first one is never drawn against a stale
  // clock. One header is mounted at a time.
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const windows = liveWindows(limits, now);

  return (
    <div className="flex items-center gap-1">
      {(cost || measured.length > 0) && (
        <HoverCard>
          <HoverCardTrigger
            render={
              <div
                className="rounded-md px-2 py-1 transition-colors hover:bg-muted/50"
                aria-label="Session cost and tokens"
              />
            }
          >
            {/* One pill, cost and tokens as its two halves, since they open one card. */}
            <span className="flex overflow-hidden rounded-md border border-border/60 text-[11px] font-medium tabular-nums">
              {cost && (
                <span className="bg-accent/15 px-1.5 py-0.5 text-accent">{money(cost)}</span>
              )}
              {measured.length > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          "bg-foreground/[0.06] px-1.5 py-0.5 text-foreground",
                          cost && "border-l border-border/60",
                        )}
                      />
                    }
                  >
                    {humanizeTokenCount(total)}
                  </TooltipTrigger>
                  <TooltipContent>{total.toLocaleString()} tokens</TooltipContent>
                </Tooltip>
              )}
            </span>
          </HoverCardTrigger>
          <HoverCardContent align="end" className={CARD}>
            {cost && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">Session cost</span>
                  <span className="text-lg font-bold tabular-nums tracking-tight text-accent">
                    {money(cost)}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  As the agent reports it. On a subscription this is the API-price equivalent, not a
                  charge.
                </div>
              </div>
            )}
            {cost && measured.length > 0 && <div className="h-px bg-border/50" />}
            {measured.length > 0 && <TokenDetails turns={measured} total={total} />}
          </HoverCardContent>
        </HoverCard>
      )}
      {/* The weekly window is in the hover card only. */}
      {limits && windows.includes("fiveHour") && (
        <HoverCard>
          <HoverCardTrigger
            render={
              <div
                className="rounded-md px-2 py-1 transition-colors hover:bg-muted/50"
                aria-label="Usage limits"
              />
            }
          >
            <WindowMeter limits={limits} id="fiveHour" now={now} />
          </HoverCardTrigger>
          <HoverCardContent align="end" className={CARD}>
            <span className="text-xs font-semibold">Usage limits</span>
            <PlanDetails limits={limits} windows={windows} now={now} />
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  );
}

function TokenDetails({ turns, total }: { turns: UsageTurn[]; total: number }) {
  const byKind = turns.map(tokensOf);
  const sums = Object.fromEntries(
    TOKEN_KINDS.map(({ kind }) => [kind, byKind.reduce((sum, t) => sum + t[kind], 0)]),
  ) as Record<TokenKind, number>;
  // A kind no turn reported is left out, rather than shown as a zero the agent never said.
  const kinds = TOKEN_KINDS.filter(({ field }) => turns.some((t) => t[field] != null));
  const shown = kinds.reduce((sum, { kind }) => sum + sums[kind], 0);

  const models = new Map<string, number>();
  for (const t of turns) {
    const model = t.model_id ?? UNKNOWN_MODEL;
    models.set(model, (models.get(model) ?? 0) + (t.total_tokens ?? 0));
  }
  const fill = new Map([...models.keys()].map((m, i) => [m, MODEL_FILL[i % MODEL_FILL.length]]));

  const active = turns.reduce(
    (sum, t) => sum + Math.max(0, Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000,
    0,
  );
  const bars = turns.slice(-MAX_BARS);
  const tallest = Math.max(...bars.map((t) => t.total_tokens ?? 0), 1);
  const last = turns[turns.length - 1];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold">Tokens</span>
        <Tooltip>
          <TooltipTrigger
            render={<span className="text-lg font-bold tabular-nums tracking-tight" />}
          >
            {humanizeTokenCount(total)}
          </TooltipTrigger>
          <TooltipContent>{total.toLocaleString()}</TooltipContent>
        </Tooltip>
      </div>
      <div className="-mt-1.5 text-muted-foreground">
        {turns.length} {turns.length === 1 ? "turn" : "turns"} · {formatCountdown(active)} active ·
        last turn {humanizeTokenCount(last.total_tokens ?? 0)}
      </div>
      <div>
        <div className="flex h-7 items-end gap-px">
          {bars.map((t, i) => (
            <Tooltip key={i}>
              <TooltipTrigger
                render={
                  <div
                    className="max-w-1.5 flex-1 rounded-[1px]"
                    style={{
                      height: `${Math.max(((t.total_tokens ?? 0) / tallest) * 100, 6)}%`,
                      background: fill.get(t.model_id ?? UNKNOWN_MODEL),
                    }}
                  />
                }
              />
              <TooltipContent>
                {t.model_id ?? UNKNOWN_MODEL} · {(t.total_tokens ?? 0).toLocaleString()} tokens
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        {/* Marks the latest turn. */}
        <div className="mt-0.5 flex gap-px">
          {bars.map((_, i) => (
            <div
              key={i}
              className={cn(
                "h-0.5 max-w-1.5 flex-1 rounded-full",
                i === bars.length - 1 && "bg-foreground",
              )}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {[...models].map(([model, tokens]) => (
          <div key={model} className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ background: fill.get(model) }}
            />
            <span className="flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {model}
            </span>
            {models.size > 1 && (
              <>
                <span className="tabular-nums">{humanizeTokenCount(tokens)}</span>
                <span className="w-8 text-right tabular-nums text-muted-foreground">
                  {Math.round((tokens / Math.max(total, 1)) * 100)}%
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {shown > 0 && (
        <div className="mt-1 flex h-1.5 gap-px overflow-hidden rounded-full bg-foreground/[0.07]">
          {kinds
            .filter(({ kind }) => sums[kind] > 0)
            .map(({ kind, color }) => (
              <div
                key={kind}
                className={color}
                style={{ width: `${Math.max((sums[kind] / shown) * 100, 1.5)}%` }}
              />
            ))}
        </div>
      )}
      <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1">
        {kinds.map(({ kind, label, color }) => (
          <div key={kind} className="contents">
            <span className={cn("h-1.5 w-1.5 self-center rounded-full", color)} />
            <span className="text-muted-foreground">{label}</span>
            <Tooltip>
              <TooltipTrigger render={<span className="text-right tabular-nums" />}>
                {humanizeTokenCount(sums[kind])}
              </TooltipTrigger>
              <TooltipContent>{sums[kind].toLocaleString()}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}

function WindowMeter({ limits, id, now }: { limits: PlanLimits; id: PlanWindowId; now: number }) {
  const w = limits.windows[id]!;
  const tone = windowTone(limits, id, now);
  return (
    <div className="w-20 text-[10px]">
      <div className="flex justify-between">
        <span className={cn("font-medium tabular-nums", TEXT[tone])}>
          {tone === "reached" ? "Limit" : `${Math.round(w.utilization * 100)}%`}
        </span>
        <span className="tabular-nums text-muted-foreground">
          {formatCountdown(w.resetsAt - now)}
        </span>
      </div>
      <Track
        usage={w.utilization}
        elapsed={elapsedShare(w, id, now)}
        tone={tone}
        className="mt-1.5 h-1"
      />
    </div>
  );
}

function PlanDetails({
  limits,
  windows,
  now,
}: {
  limits: PlanLimits;
  windows: PlanWindowId[];
  now: number;
}) {
  const overage =
    limits.overageStatus === "rejected"
      ? `Extra usage off${limits.overageDisabledReason && OVERAGE_REASON[limits.overageDisabledReason] ? ` (${OVERAGE_REASON[limits.overageDisabledReason]})` : ""}. `
      : "";
  return (
    <>
      {windows.map((id, i) => {
        const w = limits.windows[id]!;
        const tone = windowTone(limits, id, now);
        const at = new Date(w.resetsAt * 1000).toLocaleString(undefined, {
          weekday: w.resetsAt - now > 86400 ? "short" : undefined,
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <div key={id} className="contents">
            {i > 0 && <div className="h-px bg-border/50" />}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-medium">
                  <span
                    className={cn("inline-block h-1.5 w-1.5 rounded-full", DOT_COLOR[STATE[tone]])}
                  />
                  {PLAN_WINDOWS[id].label}
                </span>
                <span
                  className={cn(
                    "text-lg font-bold tabular-nums tracking-tight",
                    PCT_COLOR[STATE[tone]],
                  )}
                >
                  {Math.round(w.utilization * 100)}%
                </span>
              </div>
              <Track
                usage={w.utilization}
                elapsed={elapsedShare(w, id, now)}
                tone={tone}
                className="h-1"
              />
              <div className="text-muted-foreground">
                {tone === "reached" ? "Reached. " : ""}Resets {at}, in{" "}
                {formatCountdown(w.resetsAt - now)}
              </div>
            </div>
          </div>
        );
      })}
      <div className="h-px bg-border/50" />
      <div className="text-[10px] text-muted-foreground">
        {overage}Shared by every Claude session on this connection. Updated{" "}
        {formatCountdown(now - limits.receivedAt / 1000)} ago.
      </div>
    </>
  );
}
