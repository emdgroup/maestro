import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConcurrencySection } from "./ConcurrencySection";
import { SETTINGS_PAGES, orderedPages } from "./settings-registry";
import type { ConnectionCapacitySettings } from "@/types/bindings";

const stored = vi.hoisted(() => ({
  current: { concurrency_mode: "Auto", max_concurrent_agents: 3 } as ConnectionCapacitySettings,
}));
const save = vi.hoisted(() => vi.fn());

vi.mock("@/services/settings.service", () => ({
  useConnectionCapacity: () => ({ data: stored.current }),
  useSaveConnectionCapacity: () => ({ mutate: save }),
}));

const LOCAL = { type: "local" } as const;
const REMOTE = { type: "ssh", id: 7 } as const;

describe("ConcurrencySection", () => {
  beforeEach(() => {
    stored.current = { concurrency_mode: "Auto", max_concurrent_agents: 3 };
    save.mockReset();
  });

  /// The memory estimate is what the setting is for — a fixed number chosen before anyone knew
  /// what the machine looks like cannot protect it — so it has to be the first thing offered.
  it("offers the memory estimate before the fixed number", () => {
    render(<ConcurrencySection connection={LOCAL} />);

    const [first, second] = screen.getAllByRole("radio");
    expect(first).toBe(screen.getByRole("radio", { name: /free memory/i }));
    expect(second).toBe(screen.getByRole("radio", { name: /fixed number/i }));
  });

  it("shows the limit stored for the connection", () => {
    stored.current = { concurrency_mode: "Hard", max_concurrent_agents: 8 };

    render(<ConcurrencySection connection={REMOTE} />);

    expect(screen.getByRole("spinbutton")).toHaveValue(8);
    expect(screen.getByRole("radio", { name: /fixed number/i })).toBeChecked();
  });

  /// The regression the whole change exists to prevent: a limit saved while looking at one host
  /// must not be written against another.
  it("saves against the connection it was given", async () => {
    render(<ConcurrencySection connection={REMOTE} />);

    await userEvent.click(screen.getByRole("radio", { name: /fixed number/i }));

    expect(save).toHaveBeenCalledWith({
      connection: REMOTE,
      settings: { concurrency_mode: "Hard", max_concurrent_agents: 3 },
    });
  });

  /// The number is one value with two uses — the cap in fixed mode, the fallback in auto — so
  /// editing it must not silently switch modes.
  it("keeps the chosen mode when the number is edited", async () => {
    render(<ConcurrencySection connection={LOCAL} />);

    await userEvent.type(screen.getByRole("spinbutton"), "1");

    expect(save).toHaveBeenLastCalledWith({
      connection: LOCAL,
      settings: { concurrency_mode: "Auto", max_concurrent_agents: 31 },
    });
  });
});

describe("settings registry", () => {
  it("files Running agents under the connection scope", () => {
    const page = SETTINGS_PAGES.find((p) => p.id === "concurrency");
    expect(page?.scope).toBe("connection");
  });

  /// The welcome screen has no connection in scope, and `SettingsPage` filters it to app pages —
  /// so a host limit must not be reachable there, where there is nothing to apply it to.
  it("is absent from the welcome screen's page list", () => {
    const welcomePages = orderedPages(SETTINGS_PAGES.filter((p) => p.scope === "app"));

    expect(welcomePages.map((p) => p.id)).not.toContain("concurrency");
  });
});
