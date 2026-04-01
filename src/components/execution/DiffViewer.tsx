import React, { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { getDiffHighlighter } from "@/utils/helpers/shiki-highlighter";
import "@git-diff-view/react/styles/diff-view.css";
import { DiffFile } from "@/types/review";
import { useTheme } from "@/providers/ThemeProvider";

interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
}

const DiffPlaceholder = ({
  message,
  variant = "muted",
}: {
  message: string;
  variant?: "muted" | "error";
}) => (
  <div
    className={`flex items-center justify-center h-full text-sm ${variant === "error" ? "text-destructive" : "text-muted-foreground"}`}
  >
    {message}
  </div>
);

export const DiffViewer: React.FC<DiffViewerProps> = ({ diffFile, loading, error }) => {
  const [highlighter, setHighlighter] = useState<any>(null);
  const [highlighterError, setHighlighterError] = useState<string | null>(null);
  const { theme, systemTheme } = useTheme();
  const diffTheme = (theme === "system" ? systemTheme : theme) === "dark" ? "dark" : "light";

  // Load syntax highlighter on mount
  useEffect(() => {
    const loadHighlighter = async () => {
      try {
        const hl = await getDiffHighlighter();
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

  if (highlighterError)
    return (
      <DiffPlaceholder
        message={`Error loading syntax highlighter: ${highlighterError}`}
        variant="error"
      />
    );
  if (loading) return <DiffPlaceholder message="Loading diff..." />;
  if (error) return <DiffPlaceholder message={`Error loading diff: ${error}`} variant="error" />;
  if (!diffFile) return <DiffPlaceholder message="No changes to display" />;
  if (!highlighter) return <DiffPlaceholder message="Initializing syntax highlighter..." />;

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
