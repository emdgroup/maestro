import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DisconnectBackdrop } from "../DisconnectBackdrop";

describe("DisconnectBackdrop", () => {
  const defaultProps = {
    attempt: 0,
    maxAttempts: 5,
    onLeaveConnection: vi.fn(),
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

  it("renders failed state with leave connection button", () => {
    render(<DisconnectBackdrop {...defaultProps} state="failed" />);
    expect(screen.getByText(/Could not reconnect/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave connection/i })).toBeInTheDocument();
  });

  it("calls onLeaveConnection when button is clicked in failed state", () => {
    const onLeaveConnection = vi.fn();
    render(
      <DisconnectBackdrop {...defaultProps} state="failed" onLeaveConnection={onLeaveConnection} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /leave connection/i }));
    expect(onLeaveConnection).toHaveBeenCalledOnce();
  });

  it("shows leave connection button in lost and reconnecting states", () => {
    const { rerender } = render(
      <DisconnectBackdrop {...defaultProps} state="lost" />,
    );
    expect(screen.getByRole("button", { name: /leave connection/i })).toBeInTheDocument();

    rerender(<DisconnectBackdrop {...defaultProps} state="reconnecting" />);
    expect(screen.getByRole("button", { name: /leave connection/i })).toBeInTheDocument();
  });
});
