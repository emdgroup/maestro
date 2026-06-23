import { useState, useEffect, useRef } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "@/lib/tauri-utils";

export function extractFilename(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

interface UseFileInputOpts {
  onDrop?: () => void;
  onLeave?: () => void;
  onOver?: () => void;
}

export function appendToAttachmentsSection(description: string, filename: string): string {
  const marker = "## Attachments";
  if (description.includes(marker)) {
    return `${description}\n- ${filename}`;
  }
  const base = description.trim();
  return base ? `${base}\n\n${marker}\n- ${filename}` : `${marker}\n- ${filename}`;
}

export function useFileInput(
  isActive: boolean,
  onFile: (filename: string, filePath: string) => void,
  opts?: UseFileInputOpts,
) {
  const onFileRef = useRef(onFile);
  onFileRef.current = onFile;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!isActive) return;
    async function handlePaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file" && items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      let count = 0;
      for (const file of imageFiles) {
        try {
          const mimeType = file.type || "image/png";
          const buffer = await file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          // ponytail: chunked to avoid stack overflow on large pastes (>64K bytes)
          const CHUNK = 0x8000;
          let binary = "";
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]));
          }
          const base64Data = btoa(binary);
          const tempPath = await api.saveClipboardImage(base64Data, mimeType);
          const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
          const filename = count === 0 ? `Pasted image.${ext}` : `Pasted image (${count}).${ext}`;
          count++;
          onFileRef.current(filename, tempPath);
        } catch {
          // silently ignore
        }
      }
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        optsRef.current?.onOver?.();
      } else if (event.payload.type === "drop") {
        for (const filePath of event.payload.paths) {
          onFileRef.current(extractFilename(filePath), filePath);
        }
        optsRef.current?.onDrop?.();
      } else if (event.payload.type === "leave") {
        optsRef.current?.onLeave?.();
      }
    });
    return () => {
      unlisten.then((fn: () => void) => fn()).catch(() => {});
    };
  }, [isActive]);

  async function pickFiles() {
    const selected = await openFilePicker({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      onFileRef.current(extractFilename(filePath), filePath);
    }
  }

  return { pickFiles };
}

export function useDraggableFileInput(
  isActive: boolean,
  onFile: (filename: string, filePath: string) => void,
) {
  const [isDragging, setIsDragging] = useState(false);
  const { pickFiles } = useFileInput(isActive, onFile, {
    onOver: () => setIsDragging(true),
    onDrop: () => setIsDragging(false),
    onLeave: () => setIsDragging(false),
  });
  return { pickFiles, isDragging };
}
