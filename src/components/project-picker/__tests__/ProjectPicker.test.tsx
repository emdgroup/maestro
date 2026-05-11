import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectPicker } from "../ProjectPicker.tsx";
import { ConnectionContext } from "@/contexts/ConnectionContext.tsx";

// Mock child components
vi.mock("@/components/project-picker/ConnectionList", () => ({
  ConnectionList: () => <div data-testid="connection-list">ConnectionList</div>,
}));

vi.mock("@/components/project-picker/ProjectList", () => ({
  ProjectList: () => <div data-testid="project-list">ProjectList</div>,
}));

vi.mock("@/components/common/ThemeToggle", () => ({
  ThemeToggle: () => <div data-testid="theme-toggle">ThemeToggle</div>,
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
      const connectionList = screen.getByTestId("connection-list");

      // Check that it's not translated away (has translate-x-0 class or not -translate-x-full)
      expect(connectionList.parentElement).toHaveClass("translate-x-0");
      expect(connectionList.parentElement).not.toHaveClass("-translate-x-full");
    });

    it('hides ProjectList when view is "connections"', () => {
      renderWithContext("connections");
      const projectList = screen.getByTestId("project-list");

      // Check that it's translated away (has translate-x-full class)
      expect(projectList.parentElement).toHaveClass("translate-x-full");
    });

    it('shows ProjectList when view is "projects"', () => {
      renderWithContext("projects");
      const projectList = screen.getByTestId("project-list");

      // Check that it's not translated away (has translate-x-0 class)
      expect(projectList.parentElement).toHaveClass("translate-x-0");
      expect(projectList.parentElement).not.toHaveClass("translate-x-full");
    });

    it('hides ConnectionList when view is "projects"', () => {
      renderWithContext("projects");
      const connectionList = screen.getByTestId("connection-list");

      // Check that it's translated away and invisible
      expect(connectionList.parentElement).toHaveClass("-translate-x-full");
      expect(connectionList.parentElement).toHaveClass("invisible");
    });

    it("correctly reads view state from ConnectionContext", () => {
      // Test with "connections" view
      const { mockSetView: mockSetView1 } = renderWithContext("connections");
      expect(screen.getByTestId("connection-list").parentElement).toHaveClass("translate-x-0");
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
      expect(screen.getByTestId("connection-list").parentElement).toHaveClass("translate-x-0");
      expect(screen.getByTestId("project-list").parentElement).toHaveClass("translate-x-full");

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
      expect(screen.getByTestId("connection-list").parentElement).toHaveClass("-translate-x-full");
      expect(screen.getByTestId("project-list").parentElement).toHaveClass("translate-x-0");
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
