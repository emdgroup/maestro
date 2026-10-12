import { useState } from "react";
import type { UsageBucket } from "@/types/bindings";
import { bucketLabel } from "./range";

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** A connection that is not attached: what it last synced, drawn lighter. */
  faded?: boolean;
  /** One value per bucket. */
  values: number[];
}

interface UsageChartProps {
  buckets: string[];
  bucket: UsageBucket;
  series: ChartSeries[];
  cumulative: boolean;
  format: (value: number) => string;
}

const W = 640;
const H = 190;
const AXIS_LABELS = 5;

/**
 * Stacked bars per bucket with a dashed average, or stacked areas of the running total. Hovering
 * a bucket shows each series and the total.
 */
export function UsageChart({ buckets, bucket, series, cumulative, format }: UsageChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const n = buckets.length;
  const shown = cumulative
    ? series.map((s) => {
        let sum = 0;
        return { ...s, values: s.values.map((v) => (sum += v)) };
      })
    : series;
  const stackTotals = buckets.map((_, i) => shown.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(...stackTotals, 0) * 1.08 || 1;
  const y = (value: number) => H - (value / max) * H;
  const total = series.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);
  const average = n ? total / n : 0;
  const slot = W / Math.max(n, 1);

  const marks: React.ReactNode[] = [];
  if (cumulative) {
    const x = (i: number) => (n > 1 ? (i * W) / (n - 1) : W / 2);
    const base = buckets.map(() => 0);
    for (const s of shown) {
      const top = base.map((b, i) => b + (s.values[i] ?? 0));
      const upper = top.map((v, i) => `${x(i)},${y(v)}`);
      const lower = base.map((v, i) => `${x(i)},${y(v)}`).reverse();
      marks.push(
        <polygon
          key={s.key}
          points={[...upper, ...lower].join(" ")}
          fill={s.color}
          fillOpacity={s.faded ? 0.35 : 0.8}
          stroke="var(--card)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />,
      );
      top.forEach((v, i) => (base[i] = v));
    }
  } else {
    buckets.forEach((_, i) => {
      let top = H;
      shown.forEach((s) => {
        const value = s.values[i] ?? 0;
        if (!value) return;
        const height = (value / max) * H;
        top -= height;
        marks.push(
          <rect
            key={`${s.key}-${i}`}
            x={i * slot + slot * 0.15}
            y={top + 1}
            width={slot * 0.7}
            height={Math.max(height - 2, 0)}
            fill={s.color}
            opacity={s.faded ? 0.55 : 1}
          />,
        );
      });
    });
  }

  const step = Math.max(1, Math.ceil(n / AXIS_LABELS));
  const hovered = hover === null ? null : shown.map((s) => ({ ...s, value: s.values[hover] ?? 0 }));

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div className="relative">
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {[1, 2, 3].map((t) => (
            <line
              key={t}
              x1={0}
              x2={W}
              y1={(H * t) / 4}
              y2={(H * t) / 4}
              stroke="var(--usage-grid)"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {marks}
          {!cumulative && average > 0 && (
            <line
              x1={0}
              x2={W}
              y1={y(average)}
              y2={y(average)}
              stroke="currentColor"
              strokeOpacity={0.5}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {buckets.map((key, i) => (
            <rect
              key={key}
              x={i * slot}
              y={0}
              width={slot}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {!cumulative && average > 0 && (
          <span
            className="pointer-events-none absolute right-0 text-[10px] text-muted-foreground"
            style={{ top: y(average) - 14 }}
          >
            avg {format(average)}
          </span>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        {buckets
          .filter((_, i) => i % step === 0)
          .map((key) => (
            <span key={key}>{bucketLabel(key, bucket)}</span>
          ))}
      </div>
      {hover !== null && hovered && (
        <div
          className="home-pop pointer-events-none absolute top-8 z-10 rounded-xl px-3 py-2 text-xs"
          style={{ left: `min(${((hover + 0.5) / Math.max(n, 1)) * 100}%, calc(100% - 13rem))` }}
        >
          <div className="mb-1 font-medium">
            {cumulative ? "Total up to " : ""}
            {bucketLabel(buckets[hover], bucket)}
          </div>
          {hovered.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
              <span>{s.label}</span>
              <span className="ml-auto pl-3 font-semibold tabular-nums">{format(s.value)}</span>
            </div>
          ))}
          <div className="mt-1 text-muted-foreground">
            Total {format(hovered.reduce((sum, s) => sum + s.value, 0))}
          </div>
        </div>
      )}
    </div>
  );
}
