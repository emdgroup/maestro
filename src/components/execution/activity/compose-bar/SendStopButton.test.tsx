import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/ui/tooltip";
import { SendStopButton } from "./SendStopButton";

const button = (stop: boolean, disabled = false, onSend = vi.fn(), onCancel = vi.fn()) => (
  <TooltipProvider>
    <SendStopButton stop={stop} disabled={disabled} onSend={onSend} onCancel={onCancel} />
  </TooltipProvider>
);

describe("SendStopButton", () => {
  it("plays nothing when a session opens mid-turn", () => {
    render(button(true));
    expect(screen.getByRole("button").dataset.play).toBeUndefined();
  });

  it("plays the change each way, on the same button, until it has finished", () => {
    const { rerender } = render(button(false));
    const node = screen.getByRole("button");

    rerender(button(true));
    expect(screen.getByRole("button")).toBe(node);
    expect(node.dataset.play).toBe("start");

    // A part finishing is not the whole thing finishing.
    fireEvent.animationEnd(node.querySelector("svg")!);
    expect(node.dataset.play).toBe("start");
    fireEvent.animationEnd(node);
    expect(node.dataset.play).toBeUndefined();

    rerender(button(false));
    expect(node.dataset.play).toBe("return");
  });

  it("sends or cancels by what it shows, and only Send can be disabled", () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(button(false, false, onSend, onCancel));
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    expect(onSend).toHaveBeenCalledOnce();

    rerender(button(false, true, onSend, onCancel));
    expect(screen.getByRole("button")).toHaveProperty("disabled", true);

    rerender(button(true, true, onSend, onCancel));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledOnce();
  });
});
