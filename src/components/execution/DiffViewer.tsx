import React, { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import "@git-diff-view/react/styles/diff-view.css";
import { DiffFile } from "@/types/review";
import { useTheme } from "@/providers/ThemeProvider";

interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diffFile, loading, error }) => {
  const [highlighter, setHighlighter] = useState<any>(null);
  const [highlighterError, setHighlighterError] = useState<string | null>(null);
  const { theme, systemTheme } = useTheme();
  const diffTheme = (theme === "system" ? systemTheme : theme) === "dark" ? "dark" : "light";

  // Load syntax highlighter on mount
  useEffect(() => {
    const loadHighlighter = async () => {
      try {
        const hl = await getDiffViewHighlighter();
        setHighlighter(hl);
      } catch (err) {
        console.error("Failed to load highlighter:", err);
        setHighlighterError(
          err instanceof Error ? err.message : "Failed to load syntax highlighter",
        );
      }
    };

    loadHighlighter();
  }, []);

  if (highlighterError) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-destructive">
        <p>Error loading syntax highlighter: {highlighterError}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading diff...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-destructive">
        Error loading diff: {error}
      </div>
    );
  }

  if (!diffFile) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No changes to display
      </div>
    );
  }

  if (!highlighter) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Initializing syntax highlighter...
      </div>
    );
  }

  return (
    <div className="min-h-0">
      <DiffView
        data={diffFile}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={diffTheme}
        diffViewHighlight
        registerHighlighter={highlighter}
      />
    </div>
  );
};
