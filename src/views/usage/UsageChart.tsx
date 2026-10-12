import { useState } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { UsageBucket } from "@/types/bindings";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
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
// The SVG stretches wider than it is tall, so a corner is narrower than it is high.
const RX = 3;
const RY = 4;

/** One segment of a stacked bar, rounded only where it ends the bar: the top of the top one and
 * the bottom of the bottom one, so the joins stay square. */
function segment(
  x: number,
  y: number,
  w: number,
  h: number,
  roundTop: boolean,
  roundBottom: boolean,
) {
  const ry = Math.min(RY, h / 2);
  const rx = Math.min(RX, w / 2);
  const t = roundTop ? ry : 0;
  const b = roundBottom ? ry : 0;
  const tx = roundTop ? rx : 0;
  const bx = roundBottom ? rx : 0;
  return [
    `M${x},${y + t}`,
    t ? `A${tx},${t} 0 0 1 ${x + tx},${y}` : "",
    `H${x + w - tx}`,
    t ? `A${tx},${t} 0 0 1 ${x + w},${y + t}` : "",
    `V${y + h - b}`,
    b ? `A${bx},${b} 0 0 1 ${x + w - bx},${y + h}` : "",
    `H${x + bx}`,
    b ? `A${bx},${b} 0 0 1 ${x},${y + h - b}` : "",
    "Z",
  ].join("");
}

/**
 * Stacked bars per bucket with a dashed average, or stacked areas of the running total. Hovering
 * a bucket shows each series and the total.
 */
export function UsageChart({ buckets, bucket, series, cumulative, format }: UsageChartProps) {
  // One tooltip for every bucket, fed the hovered bucket's index.
  const [handle] = useState(() => TooltipPrimitive.createHandle<number>());
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
          fillOpacity={s.faded ? 0.3 : 0.7}
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
      const stack = shown.filter((s) => s.values[i]);
      stack.forEach((s, j) => {
        const height = (s.values[i] / max) * H;
        top -= height;
        marks.push(
          <path
            key={`${s.key}-${i}`}
            d={segment(
              i * slot + slot * 0.15,
              top + 1,
              slot * 0.7,
              Math.max(height - 2, 0),
              j === stack.length - 1,
              j === 0,
            )}
            fill={s.color}
            opacity={s.faded ? 0.45 : 0.85}
          />,
        );
      });
    });
  }

  const step = Math.max(1, Math.ceil(n / AXIS_LABELS));

  return (
    <div className="relative">
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
            <TooltipTrigger
              key={key}
              handle={handle}
              payload={i}
              delay={0}
              render={<rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />}
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
          .filter((_, i) => i % step === 0 || i === n - 1)
          .map((key) => (
            <span key={key}>{bucketLabel(key, bucket)}</span>
          ))}
      </div>
      {/* Portalled out of the view, so the content carries the series colours itself. */}
      <Tooltip handle={handle}>
        {({ payload: index }) =>
          typeof index === "number" && (
            <TooltipContent className="usage-viz flex-col items-stretch gap-0.5">
              <div className="font-medium">
                {cumulative ? "Total up to " : ""}
                {bucketLabel(buckets[index], bucket)}
              </div>
              {shown.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
                  <span>{s.label}</span>
                  <span className="ml-auto pl-3 font-semibold tabular-nums">
                    {format(s.values[index] ?? 0)}
                  </span>
                </div>
              ))}
              <div className="opacity-70">
                Total {format(shown.reduce((sum, s) => sum + (s.values[index] ?? 0), 0))}
              </div>
            </TooltipContent>
          )
        }
      </Tooltip>
    </div>
  );
}
