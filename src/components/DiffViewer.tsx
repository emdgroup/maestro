import React, { useEffect, useState } from "react";
import { DiffView, DiffModeEnum, DiffFile } from "@git-diff-view/react";
import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import "@git-diff-view/react/styles/diff-view.css";
import { DiffFile as DiffFileData } from "../types/review";
import "./DiffViewer.css";

interface DiffViewerProps {
  diffFile: DiffFileData | null;
  loading: boolean;
  error?: string;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  diffFile,
  loading,
  error,
}) => {
  const [highlighter, setHighlighter] = useState<any>(null);
  const [highlighterError, setHighlighterError] = useState<string | null>(null);
  const [diffViewFile, setDiffViewFile] = useState<DiffFile | null>(null);

  // Load syntax highlighter on mount
  useEffect(() => {
    const loadHighlighter = async () => {
      try {
        const hl = await getDiffViewHighlighter();
        setHighlighter(hl);
      } catch (err) {
        console.error("Failed to load highlighter:", err);
        setHighlighterError(
          err instanceof Error ? err.message : "Failed to load syntax highlighter"
        );
      }
    };

    loadHighlighter();
  }, []);

  // Convert DiffFileData to DiffView-compatible format when diffFile changes
  useEffect(() => {
    if (diffFile) {
      const viewFile = DiffFile.createInstance(diffFile);
      setDiffViewFile(viewFile);
    } else {
      setDiffViewFile(null);
    }
  }, [diffFile]);

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

  if (!diffViewFile) {
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
        diffFile={diffViewFile}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme="light"
        diffViewHighlight
        registerHighlighter={highlighter}
      />
    </div>
  );
};
