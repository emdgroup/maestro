import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PreflightModal } from "./PreflightModal";
import { ConnectionContext } from "@/contexts/ConnectionContext";

vi.mock("@/hooks/useProjectPickerNavigation", () => ({
  useProjectPickerNavigation: () => ({ navigateToConnections: vi.fn() }),
}));

function renderWithError(preflightError: string) {
  const startPreflight = vi.fn().mockResolvedValue(undefined);
  const connection = { id: 1, type: "ssh" as const, displayName: "box" };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionContext.Provider
        value={{
          activeConnection: connection,
          setActiveConnection: vi.fn(),
          view: "projects",
          setView: vi.fn(),
          preflightStatus: "failed",
          preflightResult: null,
          preflightError,
          startPreflight,
          ignoreWarnings: vi.fn(),
          resetPreflight: vi.fn(),
        }}
      >
        <PreflightModal />
      </ConnectionContext.Provider>
    </QueryClientProvider>,
  );
  return { startPreflight, connection };
}

describe("PreflightModal", () => {
  it("offers to update a busy server from another build, and retries with replace", () => {
    const { startPreflight, connection } = renderWithError(
      "Failed to start maestro-server: maestro-server handshake rejected: server_busy: maestro-server 0.31.0 is running on this machine and another Maestro window is connected to it",
    );

    expect(screen.getByText(/another Maestro window is connected to it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }));
    expect(startPreflight).toHaveBeenCalledWith(connection, true);
  });

  it("offers no update for any other failure", () => {
    renderWithError("Failed to deploy maestro-server: SFTP upload failed");
    expect(screen.queryByRole("button", { name: "Update anyway" })).toBeNull();
  });
});
