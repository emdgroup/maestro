import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  Scatter,
  ScatterChart,
  SunburstChart,
  Tooltip,
  Treemap,
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
  seriesType?: "line" | "bar" | "area";
}

interface Props {
  type?:
    | "line"
    | "bar"
    | "area"
    | "pie"
    | "scatter"
    | "radar"
    | "radialBar"
    | "funnel"
    | "treemap"
    | "composed"
    | "sunburst";
  data?: string | unknown[];
  xKey?: string;
  series?: SeriesItem[];
  title?: string;
  surface: CanvasSurface;
  [key: string]: unknown;
}

const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function CanvasChart({
  type = "line",
  data,
  xKey = "x",
  series = [],
  title,
  surface,
}: Props) {
  const rawData = typeof data === "string" ? surface.data[data] : data;
  const chartData: Record<string, unknown>[] = Array.isArray(rawData)
    ? (rawData as Record<string, unknown>[])
    : [];

  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [
      s.key,
      { label: s.label, color: s.color ?? PALETTE[i % PALETTE.length] },
    ]),
  );

  if (type !== "sunburst" && chartData.length === 0) {
    return <Skeleton className="h-48 w-full rounded-md" />;
  }
  if (type === "sunburst" && (rawData == null || Array.isArray(rawData))) {
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

  const titleEl = title && <p className="text-sm font-medium">{title}</p>;

  if (type === "treemap") {
    return (
      <div className="space-y-1.5">
        {titleEl}
        <div className="h-48">
          <Treemap
            width={400}
            height={192}
            data={chartData}
            dataKey={series[0]?.key ?? "value"}
            nameKey={xKey}
            style={{ width: "100%", height: "100%" }}
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={series[i]?.color ?? PALETTE[i % PALETTE.length]} />
            ))}
            <Tooltip />
          </Treemap>
        </div>
      </div>
    );
  }

  if (type === "sunburst") {
    return (
      <div className="space-y-1.5">
        {titleEl}
        <div className="h-48">
          <SunburstChart
            data={rawData as never}
            dataKey={series[0]?.key ?? "value"}
            nameKey={xKey}
            width={400}
            height={192}
            fill={series[0]?.color ?? "#6366f1"}
            stroke="#fff"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {titleEl}
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
          ) : type === "scatter" ? (
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey={xKey}
                name={xKey}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12 }}
              />
              <YAxis
                type="number"
                dataKey={series[0]?.key}
                name={series[0]?.label}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12 }}
                width={40}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {series.map((s) => (
                <Scatter
                  key={s.key}
                  name={s.label}
                  data={chartData}
                  fill={`var(--color-${s.key})`}
                />
              ))}
            </ScatterChart>
          ) : type === "radar" ? (
            <RadarChart cx="50%" cy="50%" outerRadius={70} data={chartData}>
              <PolarGrid />
              <PolarAngleAxis dataKey={xKey} tick={{ fontSize: 11 }} />
              <PolarRadiusAxis tick={{ fontSize: 10 }} />
              {series.map((s) => (
                <Radar
                  key={s.key}
                  name={s.label}
                  dataKey={s.key}
                  stroke={`var(--color-${s.key})`}
                  fill={`var(--color-${s.key})`}
                  fillOpacity={0.25}
                />
              ))}
              <Legend />
              <Tooltip />
            </RadarChart>
          ) : type === "radialBar" ? (
            <RadialBarChart cx="50%" cy="50%" innerRadius={20} outerRadius={80} data={chartData}>
              <RadialBar
                dataKey={series[0]?.key ?? "value"}
                background
                label={{ position: "insideStart", fill: "#fff", fontSize: 11 }}
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={series[i]?.color ?? PALETTE[i % PALETTE.length]} />
                ))}
              </RadialBar>
              <Legend />
              <Tooltip />
            </RadialBarChart>
          ) : type === "funnel" ? (
            <FunnelChart>
              <Tooltip />
              <Funnel
                dataKey={series[0]?.key ?? "value"}
                nameKey={xKey}
                data={chartData}
                isAnimationActive
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={series[i]?.color ?? PALETTE[i % PALETTE.length]} />
                ))}
                <LabelList position="center" fill="#fff" fontSize={12} dataKey={xKey} />
              </Funnel>
            </FunnelChart>
          ) : type === "composed" ? (
            <ComposedChart data={chartData}>
              {axes}
              {series.map((s) => {
                const st = s.seriesType ?? "line";
                if (st === "bar")
                  return (
                    <Bar
                      key={s.key}
                      dataKey={s.key}
                      fill={`var(--color-${s.key})`}
                      radius={[3, 3, 0, 0]}
                    />
                  );
                if (st === "area")
                  return (
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
                  );
                return (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    stroke={`var(--color-${s.key})`}
                    strokeWidth={2}
                    dot={false}
                  />
                );
              })}
            </ComposedChart>
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
