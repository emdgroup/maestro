import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SshConnection } from "@/types/bindings";
import { ConnectionPanel } from "./ConnectionPanel";

const getSshConnectionStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri-utils", () => ({ api: { getSshConnectionStatus } }));

const ssh = { id: 3, host: "10.0.4.22", port: 22 } as SshConnection;

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConnectionPanel
        connection={{
          key: { type: "ssh", id: 3 },
          id: "ssh:3",
          name: "gpu-runner-02",
          detail: "ml@10.0.4.22",
          ssh,
        }}
        phase={{ kind: "idle" }}
        projects={null}
        runningAutomations={0}
        minimized={false}
        onToggleMinimized={() => {}}
        openingProject={null}
        onOpenProject={() => {}}
        onRemoveProject={() => {}}
        onAddProject={() => {}}
        menu={null}
      />
    </QueryClientProvider>,
  );
}

describe("a not-connected SSH panel", () => {
  beforeEach(() => {
    getSshConnectionStatus.mockReset();
  });

  it("offers Connect while the first probe runs", () => {
    getSshConnectionStatus.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Unreachable" })).toBeNull();
  });

  it("offers Connect when the host answers", async () => {
    getSshConnectionStatus.mockResolvedValue({ connected: true });
    renderPanel();
    await screen.findByRole("button", { name: "Connect" });
    expect(screen.queryByRole("img", { name: "Unreachable" })).toBeNull();
  });

  it("marks the host unreachable and offers Refresh until it answers", async () => {
    getSshConnectionStatus.mockResolvedValue({ connected: false });
    renderPanel();
    expect(await screen.findByRole("img", { name: "Unreachable" })).toBeTruthy();

    getSshConnectionStatus.mockResolvedValue({ connected: true });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("button", { name: "Connect" });
    expect(screen.queryByRole("img", { name: "Unreachable" })).toBeNull();
  });
});
