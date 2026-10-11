import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ActivityNotice } from "./ActivityNotice";
import type { NoticeItem } from "./types";

function makeNotice(over: Partial<NoticeItem> = {}): NoticeItem {
  return {
    id: "n1",
    key: "k",
    severity: "warning",
    title: "Fast mode turned off",
    description: "Not available for the selected model.",
    count: 1,
    at: 0,
    ...over,
  };
}

describe("ActivityNotice", () => {
  it("shows a short notice in full, with no toggle", () => {
    render(<ActivityNotice notice={makeNotice()} />);
    expect(screen.getByText("Fast mode turned off")).toBeTruthy();
    expect(screen.getByText("Not available for the selected model.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the repeat count", () => {
    render(<ActivityNotice notice={makeNotice({ count: 3 })} />);
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("clamps a long notice until it is opened", () => {
    render(<ActivityNotice notice={makeNotice({ description: "x".repeat(200) })} />);
    const row = screen.getByRole("button");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("x".repeat(200)).className).toContain("line-clamp-2");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("x".repeat(200)).className).not.toContain("line-clamp-2");
  });
});
