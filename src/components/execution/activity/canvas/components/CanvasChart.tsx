import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/ui/chart";
import type { ChartConfig } from "@/ui/chart";
import { Skeleton } from "@/ui/skeleton";
import type { CanvasSurface } from "../../types";

interface SeriesItem {
  key: string;
  label: string;
  color?: string;
}

interface Props {
  type?: "line" | "bar" | "area" | "pie";
  data?: string | unknown[];
  xKey?: string;
  series?: SeriesItem[];
  title?: string;
  surface: CanvasSurface;
  [key: string]: unknown;
}

const PALETTE = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

export function CanvasChart({
  type = "line",
  data,
  xKey = "x",
  series = [],
  title,
  surface,
}: Props) {
  const chartData: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : typeof data === "string"
      ? ((surface.data[data] as Record<string, unknown>[] | undefined) ?? [])
      : [];

  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      s.key,
      { label: s.label, color: s.color ?? PALETTE[i % PALETTE.length] },
    ]),
  );

  if (chartData.length === 0) {
    return <Skeleton className="h-48 w-full rounded-md" />;
  }

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12 }} width={40} />
      <ChartTooltip content={<ChartTooltipContent />} />
    </>
  );

  return (
    <div className="space-y-1.5">
      {title && <p className="text-sm font-medium">{title}</p>}
      <div className="h-48">
        <ChartContainer config={config} className="h-full w-full">
          {type === "bar" ? (
            <BarChart data={chartData}>
              {axes}
              {series.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  fill={`var(--color-${s.key})`}
                  radius={[3, 3, 0, 0]}
                />
              ))}
            </BarChart>
          ) : type === "area" ? (
            <AreaChart data={chartData}>
              {axes}
              {series.map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={`var(--color-${s.key})`}
                  fill={`var(--color-${s.key})`}
                  fillOpacity={0.2}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </AreaChart>
          ) : type === "pie" ? (
            <PieChart>
              <Pie
                data={chartData}
                dataKey={series[0]?.key ?? "value"}
                nameKey={xKey}
                cx="50%"
                cy="50%"
                outerRadius={70}
                label
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          ) : (
            <LineChart data={chartData}>
              {axes}
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={`var(--color-${s.key})`}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          )}
        </ChartContainer>
      </div>
    </div>
  );
}
