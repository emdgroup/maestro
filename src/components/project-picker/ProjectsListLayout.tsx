import { Button } from "@/ui/button";
import { ChevronLeft, FolderOpen, FolderPlus, GitFork } from "lucide-react";
import { ReactNode, useEffect } from "react";

interface ProjectsListLayoutProps {
  /** Content for the header (icon, title, and optional actions) */
  headerContent: ReactNode;
  /** The list of projects or empty state */
  children: ReactNode;
  /** Callback when back button is clicked */
  onBack: () => void;
  /** Callback when "Select Existing" is clicked */
  onSelectNewClick: () => void;
  /** Callback when "Clone" is clicked */
  onCloneClick: () => void;
  /** Callback when "Create" is clicked */
  onCreateClick: () => void;
  /** Whether the component is in a loading state */
  loading?: boolean;
}

/**
 * Shared layout wrapper for project list components.
 * Provides consistent structure: header with back button, scrollable content area, and footer with three action buttons.
 * Keyboard navigation: Esc goes back, Tab navigates between projects and action buttons.
 */
export function ProjectsListLayout({
  headerContent,
  children,
  onBack,
  onSelectNewClick,
  onCloneClick,
  onCreateClick,
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

      <div className="pt-4 border-t border-border flex gap-2">
        <Button
          onClick={onSelectNewClick}
          disabled={loading}
          variant="outline"
          size="sm"
          className="flex-1"
        >
          <FolderOpen className="size-4" />
          Select Existing
        </Button>
        <Button
          onClick={onCloneClick}
          disabled={loading}
          variant="outline"
          size="sm"
          className="flex-1"
        >
          <GitFork className="size-4" />
          Clone
        </Button>
        <Button
          onClick={onCreateClick}
          disabled={loading}
          variant="default"
          size="sm"
          className="flex-1"
        >
          <FolderPlus className="size-4" />
          Create
        </Button>
      </div>
    </div>
  );
}
