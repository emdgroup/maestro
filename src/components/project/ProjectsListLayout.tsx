import { Button } from "../ui/button";
import { ChevronLeft, FolderPlus } from "lucide-react";
import { ReactNode, useEffect } from "react";

interface ProjectsListLayoutProps {
  /** Content for the header (icon, title, and optional actions) */
  headerContent: ReactNode;
  /** The list of projects or empty state */
  children: ReactNode;
  /** Callback when back button is clicked */
  onBack: () => void;
  /** Callback when "Select New Project" is clicked */
  onSelectNewClick: () => void;
  /** Whether the component is in a loading state */
  loading?: boolean;
}

/**
 * Shared layout wrapper for project list components.
 * Provides consistent structure: header with back button, scrollable content area, and footer with action button.
 * Keyboard navigation: Esc goes back, Tab navigates between projects and action button.
 */
export function ProjectsListLayout({
  headerContent,
  children,
  onBack,
  onSelectNewClick,
  loading = false,
}: ProjectsListLayoutProps) {
  // Handle Esc key to go back
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onBack();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          tabIndex={-1}
          className="p-1 h-auto -ml-1 hover:text-accent"
          aria-label="Back to connections (Esc)"
        >
          <ChevronLeft className="size-4" />
        </Button>
        {headerContent}
      </div>

      <div className="flex-1 overflow-auto mb-4 px-1 py-1 custom-scrollbar">{children}</div>

      <div className="pt-4 border-t border-border">
        <Button
          onClick={onSelectNewClick}
          disabled={loading}
          variant="default"
          size="lg"
          className="w-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          <FolderPlus className="size-4" />
          {loading ? "Loading..." : "Select New Project"}
        </Button>
      </div>
    </div>
  );
}
