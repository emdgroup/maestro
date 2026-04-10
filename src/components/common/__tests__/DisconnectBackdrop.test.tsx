import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DisconnectBackdrop } from "../DisconnectBackdrop";

describe("DisconnectBackdrop", () => {
  const defaultProps = {
    attempt: 0,
    maxAttempts: 5,
    onDismiss: vi.fn(),
  };

  it("renders 'SSH connection lost' text in lost state", () => {
    render(<DisconnectBackdrop {...defaultProps} state="lost" />);
    expect(screen.getByText("SSH connection lost")).toBeInTheDocument();
  });

  it("renders reconnecting state with attempt counter", () => {
    render(
      <DisconnectBackdrop
        {...defaultProps}
        state="reconnecting"
        attempt={2}
        maxAttempts={5}
      />,
    );
    expect(screen.getByText(/Reconnecting.*2\/5/)).toBeInTheDocument();
  });

  it("renders failed state with dismiss button", () => {
    render(<DisconnectBackdrop {...defaultProps} state="failed" />);
    expect(screen.getByText(/Could not reconnect/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("calls onDismiss when dismiss button is clicked in failed state", () => {
    const onDismiss = vi.fn();
    render(
      <DisconnectBackdrop {...defaultProps} state="failed" onDismiss={onDismiss} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not show dismiss button in lost or reconnecting state", () => {
    const { rerender } = render(
      <DisconnectBackdrop {...defaultProps} state="lost" />,
    );
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();

    rerender(<DisconnectBackdrop {...defaultProps} state="reconnecting" />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });
});
