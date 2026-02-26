import React, { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import "@git-diff-view/react/styles/diff-view.css";
import { DiffFile } from "../types/review";

interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diffFile, loading, error }) => {
  const [highlighter, setHighlighter] = useState<any>(null);
  const [highlighterError, setHighlighterError] = useState<string | null>(null);

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
      <div className="diff-viewer-error">
        <p>Error loading syntax highlighter: {highlighterError}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="diff-viewer-container">
        <div className="diff-viewer-loading">
          <p>Loading diff...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="diff-viewer-error">
        <p>Error loading diff: {error}</p>
      </div>
    );
  }

  if (!diffFile) {
    return (
      <div className="diff-viewer-container">
        <div className="diff-viewer-empty">
          <p>No changes to display</p>
        </div>
      </div>
    );
  }

  if (!highlighter) {
    return (
      <div className="diff-viewer-container">
        <div className="diff-viewer-loading">
          <p>Initializing syntax highlighter...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="diff-viewer-container">
      <DiffView
        data={diffFile}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme="light"
        diffViewHighlight
        registerHighlighter={highlighter}
      />
    </div>
  );
};
