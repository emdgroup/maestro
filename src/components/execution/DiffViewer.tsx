import { useEffect, useState } from "react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import {
  getDiffHighlighter,
  type DiffHighlighterInstance,
} from "@/utils/helpers/shiki-highlighter";
import "@git-diff-view/react/styles/diff-view.css";
import { DiffFile } from "@/types/review";
import { useTheme } from "@/providers/ThemeProvider";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
  diffViewMode?: DiffModeEnum;
  // Hunk selection support
  hunkSelection?: Set<number>;
  onHunkToggle?: (hunkIndex: number) => void;
}

/**
 * Parse @@ hunk headers from a unified diff string (hunks[0] element).
 * Returns an array of header strings, one per hunk block.
 */
function parseHunkHeaders(hunkContent: string): string[] {
  if (!hunkContent) return [];
  const headers: string[] = [];
  for (const line of hunkContent.split("\n")) {
    if (line.startsWith("@@")) {
      headers.push(line);
    }
  }
  return headers;
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

export function DiffViewer({
  diffFile,
  loading,
  error,
  diffViewMode,
  hunkSelection,
  onHunkToggle,
}: DiffViewerProps) {
  const [highlighter, setHighlighter] = useState<DiffHighlighterInstance | null>(null);
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

  // Parse hunk headers for the hunk summary strip (shown only when onHunkToggle is provided)
  const hunkHeaders = onHunkToggle ? parseHunkHeaders(diffFile.hunks[0] ?? "") : [];

  return (
    <div className="min-h-0 flex flex-col h-full">
      {/* Hunk summary strip — styled to blend with native @@ diff header lines */}
      {onHunkToggle && hunkHeaders.length > 0 && (
        <div className="divide-y divide-border/30 shrink-0">
          {hunkHeaders.map((header, idx) => {
            const isChecked = hunkSelection?.has(idx) ?? false;
            return (
              <div
                key={idx}
                className="flex items-center gap-1.5 px-2 py-1 cursor-pointer bg-blue-500/8 dark:bg-blue-400/10 hover:bg-blue-500/15 dark:hover:bg-blue-400/18 transition-colors"
                onClick={() => onHunkToggle(idx)}
              >
                <CheckboxPrimitive.Root
                  checked={isChecked}
                  className="border-border dark:bg-input/30 data-checked:bg-accent data-checked:text-foreground data-checked:border-foreground flex size-3.5 items-center justify-center rounded-[3px] border shadow-xs shrink-0 outline-none"
                  tabIndex={-1}
                >
                  <CheckboxPrimitive.Indicator className="[&>svg]:size-3 grid place-content-center text-current">
                    <Check className="size-3" />
                  </CheckboxPrimitive.Indicator>
                </CheckboxPrimitive.Root>
                <span className="font-mono text-xs text-blue-700 dark:text-blue-300 truncate">
                  {header}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <DiffView
          data={diffFile}
          diffViewMode={diffViewMode ?? DiffModeEnum.Unified}
          diffViewTheme={diffTheme}
          diffViewHighlight
          registerHighlighter={highlighter as any}
        />
      </div>
    </div>
  );
}
