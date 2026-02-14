import { Button } from "./ui/button";
import { Folder, ChevronLeft } from "lucide-react";
import { ReactNode } from "react";

interface ProjectsListLayoutProps {
  /** Content for the header (icon, title, and optional actions) */
  headerContent: ReactNode;
  /** The list of projects or empty state */
  children: ReactNode;
  /** Text to show when there are no projects */
  emptyMessage: string;
  /** Whether the list is empty */
  isEmpty: boolean;
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
 */
export function ProjectsListLayout({
  headerContent,
  children,
  emptyMessage,
  isEmpty,
  onBack,
  onSelectNewClick,
  loading = false,
}: ProjectsListLayoutProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="p-1 h-auto -ml-1"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        {headerContent}
      </div>

      <div className="flex-1 overflow-auto mb-4">
        {isEmpty ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            {emptyMessage}
          </p>
        ) : (
          <ul className="space-y-2">{children}</ul>
        )}
      </div>

      <div className="pt-4 border-t border-border">
        <Button
          onClick={onSelectNewClick}
          disabled={loading}
          variant="default"
          size="lg"
          className="w-full"
        >
          <Folder className="w-4 h-4" />
          {loading ? "Loading..." : "Select New Project"}
        </Button>
      </div>
    </div>
  );
}
