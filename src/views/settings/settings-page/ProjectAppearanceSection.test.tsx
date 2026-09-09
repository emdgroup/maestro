import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectAppearanceSection } from "./ProjectAppearanceSection";

/// Only for the colour picker, which reads the resolved accent out of the provider.
vi.mock("@/providers/ThemeProvider", () => ({
  useTheme: () => ({
    isDark: false,
    projectAccentHue: null,
    setProjectAccentColor: vi.fn(),
    globalAccentHue: 250,
    systemAccentHue: null,
  }),
}));

function renderSection(startupTab: string | null) {
  const onChange = vi.fn();
  render(<ProjectAppearanceSection startupTab={startupTab} onChange={onChange} />);
  return onChange;
}

const tile = (name: string) => screen.getByRole("button", { name });

describe("ProjectAppearanceSection", () => {
  it("shows Tasks as the choice when no startup tab is stored", () => {
    renderSection(null);

    expect(tile("Tasks")).toHaveAttribute("aria-pressed", "true");
    expect(tile("Agents")).toHaveAttribute("aria-pressed", "false");
  });

  it("persists a chosen tab as soon as it is picked", async () => {
    const onChange = renderSection(null);

    await userEvent.click(tile("Workspaces"));

    expect(onChange).toHaveBeenCalledWith({ startup_tab: "worktrees" });
  });

  /// Tasks stores null rather than "kanban": `useProjectAgentIntro` reads any stored value as a
  /// configured project and suppresses the first-run intro, which picking the default must not do.
  it("clears the setting when Tasks is picked", async () => {
    const onChange = renderSection("agents");

    await userEvent.click(tile("Tasks"));

    expect(onChange).toHaveBeenCalledWith({ startup_tab: null });
  });

  /// `settings` is still a legal stored value, it just has no tile.
  it("presses no tile for a tab it does not offer", () => {
    renderSection("settings");

    for (const label of ["Tasks", "Agents", "Workspaces"]) {
      expect(tile(label)).toHaveAttribute("aria-pressed", "false");
    }
  });
});
