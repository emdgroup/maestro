import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { toast } from "sonner";
import { MermaidBlock } from "./MermaidBlock";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(() => Promise.reject(new Error("Parse error on line 2:\nbad"))),
  },
}));

vi.mock("@/providers/ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", systemTheme: "light" }),
}));

describe("MermaidBlock", () => {
  // Regression: a bad diagram used to raise a toast on every mount, and the dedupe id came
  // from useId so it changed each time — switching back to a session replayed the error.
  it("falls back to the source without a toast", async () => {
    const { unmount } = render(<MermaidBlock code="graph TD\nbad" />);
    await waitFor(() => expect(screen.getByText(/Not shown as a diagram/)).toBeTruthy());
    expect(screen.getByText(/Parse error on line 2/)).toBeTruthy();

    unmount();
    render(<MermaidBlock code="graph TD\nbad" />);
    await waitFor(() => expect(screen.getByText(/Not shown as a diagram/)).toBeTruthy());

    expect(toast.error).not.toHaveBeenCalled();
  });
});
