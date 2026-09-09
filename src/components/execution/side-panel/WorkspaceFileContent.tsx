import { useEffect, useMemo } from "react";
import { Spinner } from "@/ui/spinner";
import { MarkdownBlock } from "@/components/execution/activity/MarkdownBlock";
import { useSelectedProject } from "@/store/projectStore";

function PdfViewer({ content, fileName }: { content: string; fileName: string }) {
  // The URL is derived from the content and revoked when it is replaced, rather than
  // being created in an effect and mirrored into state — which cost a first frame with
  // no iframe at all. A `data:` URL is not an option: Chromium blocks those in frames.
  const blobUrl = useMemo(() => {
    const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }, [content]);

  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);

  return <iframe src={blobUrl} title={fileName} className="flex-1 w-full min-h-0" />;
}

interface WorkspaceFileContentProps {
  content: string | null;
  isLoading: boolean;
  error: string | null;
  fileName: string | null;
  mimeType?: string;
  fileDir?: string;
  /**
   * The scrolling element for text and markdown, so a caller can keep it in step with another
   * pane. Only attached on that branch — the image, PDF, audio and video branches scroll their
   * own way and have nothing to sync with.
   */
  scrollRef?: React.Ref<HTMLDivElement>;
}

export function WorkspaceFileContent({
  content,
  isLoading,
  error,
  fileName,
  mimeType,
  fileDir,
  scrollRef,
}: WorkspaceFileContentProps) {
  const project = useSelectedProject();

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

  // Plain text does not reach here: the panel renders it through `FileEditor` in both modes, so
  // that reading and editing a file cannot disagree about how it is coloured. What is left are the
  // things an editor cannot show — rendered markdown, and the mime branches above.
  return (
    <div ref={scrollRef} className="flex-1 overflow-auto min-h-0 px-6 py-5">
      <MarkdownBlock text={content ?? ""} projectId={project?.id} baseDir={fileDir} />
    </div>
  );
}
