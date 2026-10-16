import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UsageChart, type ChartSeries } from "./UsageChart";

const minutes = Array.from({ length: 60 }, (_, i) => `2026-10-14T10:${String(i).padStart(2, "0")}`);
const days = Array.from({ length: 7 }, (_, i) => `2026-10-0${i + 1}`);
const series = (n: number): ChartSeries[] => [
  { key: "local", label: "Local", color: "red", values: Array.from({ length: n }, () => 1) },
];

describe("UsageChart", () => {
  it("survives a range with fewer buckets than the last hovered index", () => {
    const props = { cumulative: false, format: String };
    const { container, rerender } = render(
      <UsageChart buckets={minutes} bucket="minute" series={series(60)} {...props} />,
    );
    const rect = container.querySelectorAll("rect")[40];
    fireEvent.pointerEnter(rect);
    fireEvent.mouseEnter(rect);
    fireEvent.mouseMove(rect);
    expect(screen.getByText("10:40")).toBeTruthy();
    fireEvent.pointerLeave(rect);
    fireEvent.mouseLeave(rect);

    rerender(<UsageChart buckets={days} bucket="day" series={series(7)} {...props} />);
    expect(container.querySelectorAll("rect")).toHaveLength(7);
  });

  it("keeps a visible sliver of a negligible series in a stacked bar", () => {
    const { container } = render(
      <UsageChart
        buckets={["2026-10-01"]}
        bucket="day"
        series={[
          { key: "a", label: "A", color: "red", values: [999] },
          { key: "b", label: "B", color: "blue", values: [1] },
        ]}
        cumulative={false}
        format={String}
      />,
    );
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    // B rounds its top: the first arc ends on the segment's top edge, the V on its bottom.
    const d = paths[1].getAttribute("d")!;
    const top = Number(d.match(/A[^A]*?,([\d.]+)(?=H)/)![1]);
    const bottom = Number(d.match(/V([\d.]+)/)![1]);
    expect(bottom - top).toBeGreaterThanOrEqual(1);
  });

  it("selects a bucket on click only when given a handler", () => {
    const onSelect = vi.fn();
    const props = { bucket: "day" as const, series: series(7), cumulative: false, format: String };
    const { container, rerender } = render(<UsageChart buckets={days} {...props} />);
    fireEvent.click(container.querySelectorAll("rect")[3]);
    rerender(<UsageChart buckets={days} {...props} onSelect={onSelect} />);
    fireEvent.click(container.querySelectorAll("rect")[3]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(3);
  });
});
