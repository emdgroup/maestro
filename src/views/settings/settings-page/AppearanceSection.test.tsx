import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSection } from "./AppearanceSection";
import type { AppSettings } from "@/types/bindings";

const save = vi.hoisted(() => vi.fn());
const settings = vi.hoisted(() => ({ current: null as AppSettings | null }));

vi.mock("@/services/settings.service", () => ({
  useSettings: () => ({ data: settings.current }),
  useSaveSettings: () => ({ mutate: save }),
}));

vi.mock("@/providers/ThemeProvider", () => ({
  useTheme: () => ({
    uiScale: "100",
    setUiScale: vi.fn(),
    isDark: false,
    theme: "system",
    setTheme: vi.fn(),
    globalAccentHue: 250,
    setGlobalAccentColor: vi.fn(),
    systemAccentHue: null,
    reduceMotion: false,
    setReduceMotion: vi.fn(),
  }),
}));

function renderSection(patch: Partial<AppSettings> = {}) {
  settings.current = {
    theme_preference: null,
    updated_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
  render(<AppearanceSection />);
}

const terminalSwitch = () => screen.getByRole("switch", { name: /terminal follows app theme/i });

beforeEach(() => {
  save.mockClear();
});

describe("AppearanceSection", () => {
  /** `TerminalColorMode::FollowTheme` is the Rust default, so an unset setting reads as on. */
  it("shows the terminal switch on when nothing is stored", () => {
    renderSection();

    expect(terminalSwitch()).toBeChecked();
  });

  it("stores the plain xterm palette when the terminal switch is turned off", async () => {
    renderSection({ terminal_color_mode: "follow_theme" });

    await userEvent.click(terminalSwitch());

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ terminal_color_mode: "default" }));
  });

  it("persists the Enter key choice as soon as a tile is picked", async () => {
    renderSection({ enter_key_behavior: "send_prompt" });

    const newLine = screen.getByRole("button", { name: /enter adds a new line/i });
    expect(newLine).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(newLine);

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ enter_key_behavior: "new_line" }));
  });
});
