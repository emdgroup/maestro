import { useEffect, useMemo, useState } from "react";
import { endOfMonth, format as formatDate, min } from "date-fns";
import { X } from "lucide-react";
import type { ConnectionKey, UsageProjectRef, UsageSplit } from "@/types/bindings";
import { useUsageReport, useUsageSync } from "@/services/usage.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { connectionKeyId } from "@/store/homeStore";
import { SEGMENT_GROUP } from "@/lib/segmented";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { folderName, formatCost, formatMetric, formatTokens, type Metric } from "./format";
import {
  bucketKeys,
  describeDates,
  heatmapKind,
  parseKey,
  resolveRange,
  type RangeChoice,
} from "./range";
import { FilterMenu } from "./FilterMenu";
import { RangePicker } from "./RangePicker";
import { UsageBreakdown, type BreakdownRow } from "./UsageBreakdown";
import { UsageChart, type ChartSeries } from "./UsageChart";
import { UsageCalendar, UsageHeatmap } from "./UsageHeatmap";

/** How many hues each split has; the series past them fold into Other. */
const HUES: Record<UsageSplit, number> = { connection: 4, agent: 4, model: 4, token_type: 5 };
/** A split's own hues, none of them in another split's set. */
const palette = (split: UsageSplit) =>
  Array.from({ length: HUES[split] }, (_, i) => `var(--usage-${split.replace("_", "-")}-${i + 1})`);
const OTHER = "var(--usage-other)";
const TOKEN_TYPES: Record<string, string> = {
  input: "Input",
  output: "Output",
  thought: "Thought",
  cached_read: "Cache read",
  cached_write: "Cache write",
};
const SPLITS: { id: UsageSplit; label: string; tokensOnly?: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "model", label: "Model", tokensOnly: "model" },
  { id: "agent", label: "Agent" },
  { id: "token_type", label: "Token type", tokensOnly: "token type" },
];
const LOCAL: ConnectionKey = { type: "local" };
const projectId = (p: UsageProjectRef) => `${p.connection_key}|${p.project_path}`;
const segment =
  "rounded-lg px-2.5 py-1 text-xs text-muted-foreground disabled:pointer-events-none disabled:opacity-40";
const segmentOn = "bg-card/90 text-foreground shadow-sm";

function parseConnectionKey(key: string): ConnectionKey | null {
  if (key === "local") return LOCAL;
  const [type, id] = key.split(":");
  return type === "ssh" || type === "wsl" || type === "docker" ? { type, id: Number(id) } : null;
}

interface UsageViewProps {
  /** The connections Home is attached to: the only ones that can sync. */
  attached: ConnectionKey[];
  onBack: () => void;
  /** Go back to Home and connect, for a connection showing what it last synced. */
  onConnect: (connection: ConnectionKey) => void;
}

/** Cost and tokens across every connection. See docs/usage-view/design.md. */
export function UsageView({ attached, onBack, onConnect }: UsageViewProps) {
  const [choice, setChoice] = useState<RangeChoice>({ preset: "7d" });
  const [metric, setMetric] = useState<Metric>("cost");
  const [cumulative, setCumulative] = useState(false);
  const [split, setSplit] = useState<UsageSplit>("connection");
  const [projects, setProjects] = useState<UsageProjectRef[]>([]);
  const [models, setModels] = useState<string[]>([]);
  // A preset's range moves with the clock; it steps with each sync rather than every render.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useUsageSync(attached);

  const range = useMemo(() => resolveRange(choice, now), [choice, now]);
  const effectiveSplit =
    metric === "cost" && SPLITS.find((s) => s.id === split)?.tokensOnly ? "connection" : split;
  const { data: report } = useUsageReport({
    start: range.start?.toISOString() ?? null,
    end: range.end.toISOString(),
    bucket: range.bucket,
    split: effectiveSplit,
    projects,
    models,
  });
  const agents = useAgentDiscoveryQuery(LOCAL).data?.agents ?? [];
  const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;

  const format = formatMetric(metric);
  const coverage = report?.coverage ?? [];
  const attachedIds = attached.map(connectionKeyId);
  const connectionName = (key: string) => {
    const line = coverage.find((c) => c.connection_key === key);
    if (!line) return key;
    return line.removed ? `${line.connection_name} (removed)` : line.connection_name;
  };

  const earliest = report?.series[0]?.bucket;
  const buckets = bucketKeys(range, earliest);

  // Models keep one colour everywhere: the Models panel and the Model split share this map. The
  // panel ignores the model filter, so a filtered model keeps its colour.
  const modelColors = new Map(
    (report?.models ?? []).map((row, i) => [row.model, palette("model")[i] ?? OTHER]),
  );

  const series: ChartSeries[] = (() => {
    if (!report) return [];
    const valueOf = (cost: number | null, tokens: number) =>
      effectiveSplit === "model" || effectiveSplit === "token_type" || metric === "tokens"
        ? tokens
        : (cost ?? 0);
    const byKey = new Map<string, number[]>();
    for (const point of report.series) {
      const index = buckets.indexOf(point.bucket);
      if (index < 0) continue;
      const values = byKey.get(point.key) ?? buckets.map(() => 0);
      values[index] += valueOf(point.cost, point.tokens);
      byKey.set(point.key, values);
    }
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    let keys = [...byKey.keys()];
    if (effectiveSplit === "connection") {
      const order = coverage.map((c) => c.connection_key);
      keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    } else if (effectiveSplit === "token_type") {
      const order = Object.keys(TOKEN_TYPES);
      keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    } else {
      keys.sort((a, b) => sum(byKey.get(b)!) - sum(byKey.get(a)!));
    }
    const label = (key: string) =>
      effectiveSplit === "connection"
        ? connectionName(key)
        : effectiveSplit === "agent"
          ? agentName(key)
          : effectiveSplit === "token_type"
            ? TOKEN_TYPES[key]
            : key || "Unknown model";
    const colors = palette(effectiveSplit);
    const shown = keys.slice(0, colors.length).map((key, i) => ({
      key,
      label: label(key),
      color: effectiveSplit === "model" ? (modelColors.get(key) ?? colors[i]) : colors[i],
      faded: effectiveSplit === "connection" && !attachedIds.includes(key),
      values: byKey.get(key)!,
    }));
    const rest = keys.slice(colors.length);
    if (rest.length) {
      shown.push({
        key: "other",
        label: "Other",
        color: OTHER,
        faded: false,
        values: buckets.map((_, i) => rest.reduce((s, key) => s + byKey.get(key)![i], 0)),
      });
    }
    return shown;
  })();

  const projectRows: BreakdownRow[] = (report?.projects ?? [])
    .map((p) => ({
      id: projectId(p),
      name: folderName(p.project_path),
      qualifier: connectionName(p.connection_key),
      value: metric === "cost" ? p.cost : p.tokens,
      byType: p.by_type,
    }))
    .sort((a, b) => b.value - a.value);
  const modelRows: BreakdownRow[] = (report?.models ?? []).map((m) => ({
    id: m.model,
    name: m.model || "Unknown model",
    qualifier: m.agent_ids.map(agentName).join(", "),
    value: m.tokens,
    color: modelColors.get(m.model),
    byType: m.by_type,
  }));

  const cost = report?.cost ?? 0;
  const tokens = report?.tokens ?? 0;
  const per = buckets.length || 1;
  const heatmap = heatmapKind(choice);
  const stale = coverage.filter(
    (line) => !line.removed && !attachedIds.includes(line.connection_key),
  );
  const chips = [
    ...projects.map((p) => ({
      label: `${folderName(p.project_path)} · ${connectionName(p.connection_key)}`,
      remove: () => setProjects((all) => all.filter((x) => x !== p)),
    })),
    ...models.map((m) => ({
      label: m,
      remove: () => setModels((all) => all.filter((x) => x !== m)),
    })),
  ];
  const toggleFilter = (kind: "project" | "model", id: string) => {
    if (kind === "model") {
      setModels((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));
      return;
    }
    const picked = report?.projects.find((p) => projectId(p) === id);
    setProjects((all) =>
      all.some((p) => projectId(p) === id)
        ? all.filter((p) => projectId(p) !== id)
        : picked
          ? [...all, { connection_key: picked.connection_key, project_path: picked.project_path }]
          : all,
    );
  };

  // Drill in: a day or a month becomes the range. Hours and minutes have no finer range to open.
  const selectDay = (day: Date) => setChoice({ from: day, to: day });
  const selectBucket =
    range.bucket === "day" || range.bucket === "month"
      ? (index: number) => {
          const from = parseKey(buckets[index], range.bucket);
          setChoice({ from, to: range.bucket === "day" ? from : min([endOfMonth(from), now]) });
        }
      : undefined;

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 cursor-pointer text-sm text-muted-foreground hover:text-foreground"
      >
        ‹ Home
      </button>
      <section className="usage-viz home-glass rounded-[22px] p-6">
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">
          Usage <span className="font-normal text-muted-foreground">over the</span>{" "}
          <RangePicker choice={choice} onChange={setChoice} />
        </h1>
        <div className="mt-1 text-xs text-muted-foreground">{describeDates(range, earliest)}</div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          Filters:
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="flex items-center gap-1 rounded-full border border-foreground/15 py-0.5 pr-1.5 pl-2.5 text-[11px] text-foreground"
            >
              {chip.label}
              <button type="button" aria-label={`Remove ${chip.label}`} onClick={chip.remove}>
                <X className="size-3" />
              </button>
            </span>
          ))}
          <FilterMenu
            projects={projectRows}
            models={modelRows}
            selected={[...projects.map(projectId), ...models]}
            onToggle={toggleFilter}
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          {(
            [
              ["cost", "Cost", formatCost(cost), formatCost(cost / per)],
              ["tokens", "Tokens", formatTokens(tokens), formatTokens(tokens / per)],
            ] as const
          ).map(([id, label, total, average]) => (
            <button
              key={id}
              type="button"
              aria-pressed={metric === id}
              onClick={() => setMetric(id)}
              className={cn(
                "usage-pane cursor-pointer rounded-2xl px-5 py-4 text-left transition",
                // `!`: .usage-pane sets the border outside any layer, so it beats a plain utility.
                metric === id ? "border-accent! ring-2 ring-accent/25" : "opacity-75",
              )}
            >
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="flex items-baseline gap-3">
                <span className="text-[34px] leading-tight font-semibold tracking-[-0.025em] tabular-nums">
                  {total}
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  avg {average} / {range.bucket}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className="usage-pane mt-4 rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-3">
            <div className={cn("flex gap-1", SEGMENT_GROUP)}>
              {[false, true].map((cum) => (
                <button
                  key={String(cum)}
                  type="button"
                  onClick={() => setCumulative(cum)}
                  className={cn(segment, cumulative === cum && segmentOn)}
                >
                  {cum ? "Cumulative" : "Over time"}
                </button>
              ))}
            </div>
            <div className={cn("ml-auto flex gap-1", SEGMENT_GROUP)}>
              {SPLITS.map((s) => {
                const disabled = metric === "cost" && !!s.tokensOnly;
                const button = (
                  <button
                    key={s.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => setSplit(s.id)}
                    className={cn(segment, effectiveSplit === s.id && segmentOn)}
                  >
                    {s.label}
                  </button>
                );
                if (!disabled) return button;
                // A disabled button fires no pointer events, so the wrapper carries the tooltip.
                return (
                  <Tooltip key={s.id}>
                    <TooltipTrigger render={<span className="inline-flex cursor-not-allowed" />}>
                      {button}
                    </TooltipTrigger>
                    <TooltipContent>
                      Tokens only: cost is recorded per turn, not per {s.tokensOnly}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((s) => {
              const swatch = (
                <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
              );
              if (effectiveSplit !== "model" || s.key === "other") {
                return (
                  <span key={s.key} className="flex items-center gap-1.5">
                    {swatch}
                    {s.label}
                  </span>
                );
              }
              return (
                <button
                  key={s.key}
                  type="button"
                  aria-pressed={models.includes(s.key)}
                  onClick={() => toggleFilter("model", s.key)}
                  className="flex cursor-pointer items-center gap-1.5 hover:text-foreground aria-pressed:text-foreground"
                >
                  {swatch}
                  {s.label}
                </button>
              );
            })}
          </div>
          <UsageChart
            buckets={buckets}
            bucket={range.bucket}
            series={series}
            cumulative={cumulative}
            format={format}
            onSelect={selectBucket}
          />
        </div>

        {heatmap && (
          <div className="usage-pane mt-4 rounded-2xl p-4">
            <div className="mb-3 text-sm font-semibold">
              {metric === "cost" ? "Cost" : "Tokens"}{" "}
              {heatmap === "hours" ? "by hour and weekday" : "per day"}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                {describeDates(range, earliest)}
              </span>
            </div>
            {heatmap === "hours" ? (
              <UsageHeatmap
                cells={report?.heatmap ?? []}
                start={range.start ?? parseKey(buckets[0], range.bucket)}
                metric={metric}
                format={format}
                onSelectDay={selectDay}
              />
            ) : (
              <UsageCalendar
                days={report?.days ?? []}
                start={range.start ?? parseKey(buckets[0], range.bucket)}
                end={range.end}
                metric={metric}
                format={format}
                onSelectDay={selectDay}
              />
            )}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div className="usage-pane rounded-2xl p-4">
            <div className="mb-1 text-sm font-semibold">Projects · {metric}</div>
            <UsageBreakdown rows={projectRows} format={format} />
          </div>
          <div className="usage-pane rounded-2xl p-4">
            <div className="mb-1 text-sm font-semibold">
              Models · tokens
              {metric === "cost" && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  cost is not recorded per model
                </span>
              )}
            </div>
            <UsageBreakdown rows={modelRows} format={formatTokens} />
          </div>
        </div>

        {stale.map((line) => {
          const key = parseConnectionKey(line.connection_key);
          return (
            <div key={line.connection_key} className="mt-4 text-xs text-muted-foreground">
              <span className="text-foreground">{line.connection_name}</span> not connected: showing
              its usage up to{" "}
              <b>
                {line.synced_at ? formatDate(new Date(line.synced_at), "MMM d, HH:mm") : "never"}
              </b>{" "}
              (cached).{" "}
              {key && (
                <button type="button" className="underline" onClick={() => onConnect(key)}>
                  Connect
                </button>
              )}{" "}
              to refresh.
            </div>
          );
        })}
      </section>
    </>
  );
}
