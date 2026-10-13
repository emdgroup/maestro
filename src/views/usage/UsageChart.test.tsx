import { describe, it, expect } from "vitest";
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
});
