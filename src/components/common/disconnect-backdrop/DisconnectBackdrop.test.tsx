import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DisconnectBackdrop } from "./DisconnectBackdrop";

describe("DisconnectBackdrop", () => {
  const defaultProps = {
    attempt: 0,
    maxAttempts: 5,
    connection: { type: "ssh" as const, id: 1 },
    onLeaveConnection: vi.fn(),
  };

  it("renders 'SSH connection lost' text in lost state", () => {
    render(<DisconnectBackdrop {...defaultProps} state="lost" />);
    expect(screen.getByText("SSH connection lost")).toBeInTheDocument();
  });

  it("renders reconnecting state with attempt counter", () => {
    render(
      <DisconnectBackdrop {...defaultProps} state="reconnecting" attempt={2} maxAttempts={5} />,
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
    const { rerender } = render(<DisconnectBackdrop {...defaultProps} state="lost" />);
    expect(screen.getByRole("button", { name: /leave connection/i })).toBeInTheDocument();

    rerender(<DisconnectBackdrop {...defaultProps} state="reconnecting" />);
    expect(screen.getByRole("button", { name: /leave connection/i })).toBeInTheDocument();
  });

  it("names what actually stopped, per connection type", () => {
    const { rerender } = render(
      <DisconnectBackdrop {...defaultProps} connection={{ type: "docker", id: 3 }} state="lost" />,
    );
    expect(screen.getByText("Container stopped")).toBeInTheDocument();

    rerender(
      <DisconnectBackdrop {...defaultProps} connection={{ type: "wsl", id: 3 }} state="lost" />,
    );
    expect(screen.getByText("WSL distro stopped")).toBeInTheDocument();

    rerender(<DisconnectBackdrop {...defaultProps} connection={{ type: "local" }} state="lost" />);
    expect(screen.getByText("Agent server stopped")).toBeInTheDocument();
  });

  it("does not promise a recovery it cannot perform", () => {
    render(
      <DisconnectBackdrop {...defaultProps} connection={{ type: "docker", id: 3 }} state="lost" />,
    );
    // SSH is the only transport that reconnects itself; the rest must not imply otherwise.
    expect(screen.queryByText(/Detecting connection status/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Attempting to restore/)).not.toBeInTheDocument();
  });
});
