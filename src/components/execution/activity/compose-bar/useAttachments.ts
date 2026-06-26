import { useState, useRef, useCallback } from "react";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri-utils";
import type { AcpPromptCapabilities } from "../useAcpSessionLifecycle";
import { isImageExtension } from "../fileTypeUtils";
import type { ExternalAttachment } from "./externalAttachment";

interface Params {
  promptCapabilities: AcpPromptCapabilities | null | undefined;
  logId: number | null | undefined;
}

export function useAttachments({ promptCapabilities, logId }: Params) {
  const [attachments, setAttachments] = useState<ExternalAttachment[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const handleAttach = useCallback(async () => {
    const selected = await openFilePicker({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const path of paths) {
      const isImage = isImageExtension(path);
      if (isImage && !promptCapabilities?.image) continue;
      const displayName = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
      setAttachments((prev) => [
        ...prev,
        { id: crypto.randomUUID(), displayName, localAbsPath: path, isImage },
      ]);
    }
  }, [promptCapabilities]);

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!promptCapabilities?.image || !logId) return;
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

      let pastedCount = attachmentsRef.current.filter((a) =>
        a.displayName.startsWith("Pasted image"),
      ).length;

      for (const file of imageFiles) {
        const mimeType = file.type || "image/png";
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Data = btoa(binary);
        const tempPath = await api.saveClipboardImage(base64Data, mimeType);
        const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        const displayName =
          pastedCount === 0 ? `Pasted image.${ext}` : `Pasted image (${pastedCount + 1}).${ext}`;
        pastedCount += 1;
        setAttachments((prev) => [
          ...prev,
          { id: crypto.randomUUID(), displayName, localAbsPath: tempPath, isImage: true },
        ]);
      }
    },
    [promptCapabilities, logId],
  );

  const reset = useCallback(() => {
    setAttachments([]);
  }, []);

  return { attachments, setAttachments, handleAttach, handlePaste, reset };
}
