import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageReport } from "@/types/bindings";
import { UsageView } from "./UsageView";

const getUsageReport = vi.hoisted(() => vi.fn());
const syncUsage = vi.hoisted(() => vi.fn());
const discoverAgents = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri-utils", () => ({ api: { getUsageReport, syncUsage, discoverAgents } }));
// The range picker draws two months of day buttons every time it opens, and no test here picks a
// day from it.
vi.mock("@/ui/calendar", () => ({ Calendar: () => null }));

const split = { input: 60, output: 10, thought: 0, cached_read: 30, cached_write: 0 };
const report: UsageReport = {
  cost: 3.5,
  tokens: 160,
  series: [],
  heatmap: [],
  days: [],
  projects: [
    {
      connection_key: "local",
      project_path: "/src/maestro",
      cost: 3.5,
      tokens: 160,
      by_type: split,
    },
  ],
  models: [{ model: "claude-opus", agent_ids: ["claude-acp"], tokens: 100, by_type: split }],
  coverage: [
    { connection_key: "local", connection_name: "This computer", synced_at: null, removed: false },
    {
      connection_key: "ssh:3",
      connection_name: "gpu-rig",
      synced_at: "2026-10-09T12:02:00Z",
      removed: false,
    },
  ],
};

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsageView attached={[{ type: "local" }]} onBack={() => {}} onConnect={() => {}} />
    </QueryClientProvider>,
  );
}

describe("the Usage view", () => {
  beforeEach(() => {
    getUsageReport.mockReset().mockResolvedValue(report);
    syncUsage.mockReset().mockResolvedValue(null);
    discoverAgents.mockReset().mockResolvedValue({ maestro_server_available: true, agents: [] });
  });

  it("syncs only the attached connections and names the others as cached", async () => {
    renderView();
    expect(await screen.findByText("gpu-rig")).toBeTruthy();
    expect(screen.getByText(/not connected: showing/)).toBeTruthy();
    expect(syncUsage).toHaveBeenCalledWith({ type: "local" });
    expect(syncUsage).toHaveBeenCalledTimes(1);
  });

  it("disables the tokens-only splits under Cost, and enables them under Tokens", async () => {
    renderView();
    await screen.findByText("gpu-rig");
    const model = () => screen.getByRole("button", { name: "Model" }) as HTMLButtonElement;
    expect(model().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Token type" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Tokens/, pressed: false }));
    expect(model().disabled).toBe(false);
  });

  it("hides the heatmap under 7 days, and shows days past 7", async () => {
    renderView();
    expect(await screen.findByText(/by hour and weekday/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /last 7 days/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Last 24 hours" }));
    expect(screen.queryByText(/by hour and weekday/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /last 24 hours/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Last 30 days" }));
    expect(await screen.findByText(/Cost per day/)).toBeTruthy();
  });

  it("expands a clicked row rather than filtering", async () => {
    renderView();
    fireEvent.click(await screen.findByText("maestro"));
    expect(screen.getAllByText("Cache read").length).toBeGreaterThan(0);
    expect(getUsageReport).toHaveBeenLastCalledWith(expect.objectContaining({ projects: [] }));
  });

  it("filters by a project picked in the Filter menu", async () => {
    renderView();
    await screen.findByText("maestro");
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /maestro/ }));
    const filters = screen.getByText(/^Filters:/);
    expect(within(filters).getByText(/maestro · This computer/)).toBeTruthy();
    expect(getUsageReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projects: [{ connection_key: "local", project_path: "/src/maestro" }],
      }),
    );
  });
});
