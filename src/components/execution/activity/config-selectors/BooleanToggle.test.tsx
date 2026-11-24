import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigSelector } from "./ConfigSelector";

const fast = { id: "fast", name: "Fast mode", type: "boolean", currentValue: "false", options: [] };

describe("ConfigSelector — boolean options", () => {
  it("draws a switch that flips the value", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ConfigSelector option={fast} value="false" onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Fast mode" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("true");

    rerender(<ConfigSelector option={fast} value="true" onChange={onChange} />);
    expect(screen.getByRole("switch", { name: "Fast mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("switch", { name: "Fast mode" }));
    expect(onChange).toHaveBeenLastCalledWith("false");
  });
});
