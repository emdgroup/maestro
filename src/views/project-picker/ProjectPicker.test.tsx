import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectPicker } from "./ProjectPicker";
import { ConnectionContext } from "@/contexts/ConnectionContext.tsx";

// Mock child components
vi.mock("./ConnectionList", () => ({
  ConnectionList: () => <div data-testid="connection-list">ConnectionList</div>,
}));

vi.mock("./ProjectList", () => ({
  ProjectList: () => <div data-testid="project-list">ProjectList</div>,
}));

vi.mock("@/components/common/theme-toggle/ThemeToggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle">ThemeToggle</div>,
}));

vi.mock("./IntegrationsTab", () => ({
  IntegrationsTab: () => <div data-testid="integrations-tab">IntegrationsTab</div>,
}));

// Test utilities
function renderWithContext(view: "connections" | "projects" = "connections") {
  const mockSetView = vi.fn();
  const mockSetActiveConnection = vi.fn();

  const mockStartPreflight = vi.fn();

  return {
    ...render(
      <ConnectionContext.Provider
        value={{
          view,
          setView: mockSetView,
          activeConnection: null,
          setActiveConnection: mockSetActiveConnection,
          preflightResult: null,
          preflightStatus: "passed",
          preflightError: null,

          startPreflight: mockStartPreflight,
          ignoreWarnings: vi.fn(),
          resetPreflight: vi.fn(),
        }}
      >
        <ProjectPicker />
      </ConnectionContext.Provider>,
    ),
    mockSetView,
    mockSetActiveConnection,
  };
}

describe("ProjectPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Component Rendering", () => {
    it("renders without crashing", () => {
      renderWithContext();
      expect(screen.getByText("Maestro")).toBeInTheDocument();
    });

    it("renders ThemeToggle component", () => {
      renderWithContext();
      expect(screen.getByTestId("theme-toggle")).toBeInTheDocument();
    });

    it("renders ConnectionList component", () => {
      renderWithContext();
      expect(screen.getByTestId("connection-list")).toBeInTheDocument();
    });

    it("renders ProjectList component", () => {
      renderWithContext();
      expect(screen.getByTestId("project-list")).toBeInTheDocument();
    });
  });

  describe("View State Logic", () => {
    it('shows ConnectionList when view is "connections"', () => {
      renderWithContext("connections");
      const panel = screen.getByTestId("connections-panel");

      expect(panel).toHaveClass("translate-x-0");
      expect(panel).not.toHaveClass("-translate-x-full");
    });

    it('hides ProjectList when view is "connections"', () => {
      renderWithContext("connections");
      const panel = screen.getByTestId("projects-panel");

      expect(panel).toHaveClass("translate-x-full");
    });

    it('shows ProjectList when view is "projects"', () => {
      renderWithContext("projects");
      const panel = screen.getByTestId("projects-panel");

      expect(panel).toHaveClass("translate-x-0");
      expect(panel).not.toHaveClass("translate-x-full");
    });

    it('hides ConnectionList when view is "projects"', () => {
      renderWithContext("projects");
      const panel = screen.getByTestId("connections-panel");

      expect(panel).toHaveClass("-translate-x-full");
      expect(panel).toHaveClass("invisible");
    });

    it("correctly reads view state from ConnectionContext", () => {
      const { mockSetView: mockSetView1 } = renderWithContext("connections");
      expect(screen.getByTestId("connections-panel")).toHaveClass("translate-x-0");
      expect(mockSetView1).not.toHaveBeenCalled();
    });
  });

  describe("Context Integration", () => {
    it("consumes ConnectionContext correctly", () => {
      // Should not throw when rendered with context
      expect(() => renderWithContext()).not.toThrow();
    });

    it("responds to view state changes in context", () => {
      // Render with "connections" view
      const { rerender } = render(
        <ConnectionContext.Provider
          value={{
            view: "connections",
            setView: vi.fn(),
            activeConnection: null,
            setActiveConnection: vi.fn(),
            preflightResult: null,
            preflightStatus: "passed",
            preflightError: null,

            startPreflight: vi.fn(),
            ignoreWarnings: vi.fn(),
            resetPreflight: vi.fn(),
          }}
        >
          <ProjectPicker />
        </ConnectionContext.Provider>,
      );

      // Verify initial state
      expect(screen.getByTestId("connections-panel")).toHaveClass("translate-x-0");
      expect(screen.getByTestId("projects-panel")).toHaveClass("translate-x-full");

      // Re-render with "projects" view
      rerender(
        <ConnectionContext.Provider
          value={{
            view: "projects",
            setView: vi.fn(),
            activeConnection: null,
            setActiveConnection: vi.fn(),
            preflightResult: null,
            preflightStatus: "passed",
            preflightError: null,

            startPreflight: vi.fn(),
            ignoreWarnings: vi.fn(),
            resetPreflight: vi.fn(),
          }}
        >
          <ProjectPicker />
        </ConnectionContext.Provider>,
      );

      // Verify updated state
      expect(screen.getByTestId("connections-panel")).toHaveClass("-translate-x-full");
      expect(screen.getByTestId("projects-panel")).toHaveClass("translate-x-0");
    });

    it("does not call setView (component only reads, does not write)", () => {
      const { mockSetView } = renderWithContext("connections");

      // Component should not call setView during render
      expect(mockSetView).not.toHaveBeenCalled();
    });

    it("handles context re-renders without errors", () => {
      const { rerender } = render(
        <ConnectionContext.Provider
          value={{
            view: "connections",
            setView: vi.fn(),
            activeConnection: null,
            setActiveConnection: vi.fn(),
            preflightResult: null,
            preflightStatus: "passed",
            preflightError: null,

            startPreflight: vi.fn(),
            ignoreWarnings: vi.fn(),
            resetPreflight: vi.fn(),
          }}
        >
          <ProjectPicker />
        </ConnectionContext.Provider>,
      );

      // Re-render multiple times with same context
      expect(() => {
        rerender(
          <ConnectionContext.Provider
            value={{
              view: "connections",
              setView: vi.fn(),
              activeConnection: null,
              setActiveConnection: vi.fn(),
              preflightResult: null,
              preflightStatus: "passed",
              preflightError: null,

              startPreflight: vi.fn(),
              ignoreWarnings: vi.fn(),
              resetPreflight: vi.fn(),
            }}
          >
            <ProjectPicker />
          </ConnectionContext.Provider>,
        );
      }).not.toThrow();

      expect(screen.getByTestId("connection-list")).toBeInTheDocument();
      expect(screen.getByTestId("project-list")).toBeInTheDocument();
    });
  });
});
