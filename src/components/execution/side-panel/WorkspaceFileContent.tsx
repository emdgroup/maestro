import { useState, useEffect } from "react";
import { cn } from "@/lib/utils.ts";
import { Spinner } from "@/ui/spinner";
import { langForExtension } from "@/components/execution/activity/fileTypeUtils";
import { HighlightedCode, MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";

function PdfViewer({ content, fileName }: { content: string; fileName: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [content]);
  if (!blobUrl) return null;
  return <iframe src={blobUrl} title={fileName} className="flex-1 w-full min-h-0" />;
}

interface WorkspaceFileContentProps {
  content: string | null;
  isLoading: boolean;
  error: string | null;
  fileName: string | null;
  mimeType?: string;
  fileDir?: string;
}

export function WorkspaceFileContent({
  content,
  isLoading,
  error,
  fileName,
  mimeType,
  fileDir,
}: WorkspaceFileContentProps) {
  const project = useSelectedProject();
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
        <Spinner className="text-muted-foreground" />
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

  if (mimeType) {
    const src = `data:${mimeType};base64,${content}`;
    if (mimeType.startsWith("image/")) {
      return (
        <div className="flex-1 overflow-auto p-4 min-h-0 flex items-center justify-center">
          <img src={src} alt={fileName} className="max-w-full block" />
        </div>
      );
    }
    if (mimeType === "application/pdf") {
      return <PdfViewer content={content} fileName={fileName ?? ""} />;
    }
    if (mimeType.startsWith("audio/")) {
      return (
        <div className="flex-1 flex items-center justify-center p-4">
          <audio controls src={src} className="w-full max-w-md" />
        </div>
      );
    }
    if (mimeType.startsWith("video/")) {
      return (
        <div className="flex-1 flex items-center justify-center overflow-auto p-4">
          <video controls src={src} className="max-w-full max-h-full" />
        </div>
      );
    }
  }

  const isMarkdown = fileName?.toLowerCase().endsWith(".md") ?? false;

  return (
    <div
      className={cn(
        "flex-1 overflow-auto custom-scrollbar min-h-0",
        isMarkdown ? "px-6 py-5" : "p-0",
      )}
    >
      {isMarkdown ? (
        <MarkdownBlock text={content ?? ""} projectId={project?.id} baseDir={fileDir} />
      ) : (
        <div className="min-w-max file-code-view">
          <HighlightedCode code={content} lang={lang} stripContainerStyle />
        </div>
      )}
    </div>
  );
}
