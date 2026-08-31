import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsSidebar } from "./SettingsSidebar";
import { SETTINGS_PAGES } from "./settings-registry";

/// The two hosts of the settings surface: in a project every scope is registered, on the
/// welcome screen only the application one is.
const APP_ONLY = SETTINGS_PAGES.filter((p) => p.scope === "app");

function renderSidebar(pages = SETTINGS_PAGES) {
  const onSelect = vi.fn();
  const onQueryChange = vi.fn();
  const { rerender, container } = render(
    <SettingsSidebar
      pages={pages}
      activeId="updates"
      onSelect={onSelect}
      query=""
      onQueryChange={onQueryChange}
      connectionLabel="build-box"
      projectLabel="maestro"
    />,
  );
  const withQuery = (query: string) =>
    rerender(
      <SettingsSidebar
        pages={pages}
        activeId="updates"
        onSelect={onSelect}
        query={query}
        onQueryChange={onQueryChange}
        connectionLabel="build-box"
        projectLabel="maestro"
      />,
    );
  return { onSelect, onQueryChange, withQuery, container };
}

const pageNames = () => screen.getAllByRole("button").map((b) => b.textContent);

describe("SettingsSidebar", () => {
  it("groups pages under a heading naming the project", () => {
    renderSidebar();

    expect(screen.getByText("Application")).toBeTruthy();
    expect(screen.getByText("Connection · build-box")).toBeTruthy();
    expect(screen.getByText("Project · maestro")).toBeTruthy();
  });

  /// Nearest scope first. What brought the user to Settings is nearly always the project in
  /// front of them; the application-wide preferences are the ones set once and left alone.
  it("orders the groups from project out to application", () => {
    const { container } = renderSidebar();

    const headings = [...container.querySelectorAll("nav p")].map((p) => p.textContent);

    expect(headings).toEqual(["Project · maestro", "Connection · build-box", "Application"]);
  });

  /// An empty group must not draw a heading over nothing — that is what lets a scope exist
  /// before it has settings, and what keeps the welcome screen from listing hosts it has none of.
  it("draws no heading for a scope with no pages", () => {
    renderSidebar(SETTINGS_PAGES.filter((p) => p.scope !== "connection"));

    expect(screen.queryByText(/^Connection/)).toBeNull();
  });

  /// The welcome screen has no project and no connection, so those groups are absent rather
  /// than present and disabled.
  it("renders only the application group when no project is open", () => {
    renderSidebar(APP_ONLY);

    expect(screen.getByText("Application")).toBeTruthy();
    expect(screen.queryByText(/^Connection/)).toBeNull();
    expect(screen.queryByText(/^Project/)).toBeNull();
  });

  /// Searching by a control name, not a page name — the thing a user actually remembers.
  it("finds a page by a control it renders", () => {
    const { withQuery } = renderSidebar();
    withQuery("log level");

    const names = pageNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("Diagnostics");
    // The matched term is shown, so the result explains itself.
    expect(names[0]).toContain("log level");
  });

  it("finds a page by its own name", () => {
    const { withQuery } = renderSidebar();
    withQuery("notifications");

    expect(pageNames()).toEqual([expect.stringContaining("Notifications")]);
  });

  /// "Appearance" exists under both Application and Project, and a search for it must keep
  /// both — collapsing them would hide the very distinction the grouping exists to make.
  it("keeps same-named pages from different scopes apart", () => {
    const { withQuery } = renderSidebar();
    withQuery("appearance");

    expect(pageNames()).toHaveLength(2);
    expect(screen.getByText("Application")).toBeTruthy();
    expect(screen.getByText("Project · maestro")).toBeTruthy();
  });

  it("reports when nothing matches", () => {
    const { withQuery } = renderSidebar();
    withQuery("zzzz");

    expect(screen.getByText(/No settings match/)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("selects a page when its entry is clicked", async () => {
    const { onSelect } = renderSidebar();

    await userEvent.click(screen.getByText("Diagnostics"));

    expect(onSelect).toHaveBeenCalledWith("diagnostics");
  });
});
