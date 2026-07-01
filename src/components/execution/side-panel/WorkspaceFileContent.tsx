import { Loader2 } from "lucide-react";
import { cn } from "@/lib/ui-utils";
import { langForExtension } from "@/components/execution/activity/fileTypeUtils";
import { HighlightedCode, MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";

interface WorkspaceFileContentProps {
  content: string | null;
  isLoading: boolean;
  error: string | null;
  fileName: string | null;
}

export function WorkspaceFileContent({
  content,
  isLoading,
  error,
  fileName,
}: WorkspaceFileContentProps) {
  const lang = fileName ? (langForExtension(fileName) ?? "text") : "text";

  if (!fileName) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-xs text-muted-foreground">Select a file to view its contents</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    const isBinary = error.includes("Binary file");
    const isTooLarge = error.includes("too large");
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">
          {isBinary
            ? "Cannot display binary file"
            : isTooLarge
              ? "File is too large to display"
              : error}
        </p>
      </div>
    );
  }

  if (content === null) return null;

  const isMarkdown = fileName?.toLowerCase().endsWith(".md") ?? false;

  return (
    <div
      className={cn(
        "flex-1 overflow-auto custom-scrollbar min-h-0",
        isMarkdown ? "px-6 py-5" : "p-0",
      )}
    >
      {isMarkdown ? (
        <MarkdownBlock text={content} />
      ) : (
        <div className="file-code-view">
          <HighlightedCode code={content} lang={lang} />
        </div>
      )}
    </div>
  );
}
