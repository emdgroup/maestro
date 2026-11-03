import { ExternalLink, FolderDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { CopyStateIcon } from "@/components/common/CopyStateIcon";
import {
  openFileWithConnection,
  downloadFileToFolder,
  opensViaHostCopy,
} from "@/services/connection.service";
import type { ConnectionKey } from "@/types/bindings";
import { ToolbarButton } from "./ToolbarButton";
import { TransferIcon } from "./TransferIcon";
import { transferTooltip, useFileTransfer } from "./useFileTransfer";

/**
 * A file panel's title: the file name, which copies `absolutePath` when clicked. The copy icon
 * shows on hover so the bar still reads as a title; the tooltip carries `title`.
 */
export function FileNameCopyButton({
  fileName,
  title,
  absolutePath,
}: {
  fileName: string;
  title: string;
  absolutePath: string;
}) {
  const { copied, copy } = useCopyToClipboard(absolutePath);
  return (
    <Tooltip trackCursorAxis="x">
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={copy}
            className="group/name flex items-center gap-1 min-w-0 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
          />
        }
      >
        <span className="truncate">{fileName}</span>
        <CopyStateIcon
          copied={copied}
          className={cn(
            "size-3 shrink-0",
            !copied &&
              "opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100 transition-opacity",
          )}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Open in the default application, and on a remote connection Download to a folder. Each button
 * shows its own transfer's progress and outcome.
 */
export function FileHeaderActions({
  connection,
  path,
  wslDistroName,
}: {
  connection: ConnectionKey;
  /** The file on the connection's machine, or null when nothing can be opened yet. */
  path: string | null;
  wslDistroName?: string;
}) {
  const openTransfer = useFileTransfer();
  const downloadTransfer = useFileTransfer();
  const openLabel = opensViaHostCopy(connection)
    ? "Download and open"
    : "Open in default application";

  async function handleOpen() {
    if (!path) return;
    const transferId = `open-${Date.now()}`;
    await openTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () =>
        openFileWithConnection(connection, path, {
          sshConnectionId: connection.type === "ssh" ? connection.id : undefined,
          transferId,
          wslDistroName,
        }),
      // The file opening is its own confirmation, so success stays quiet here.
    });
  }

  async function handleDownload() {
    if (!path || connection.type === "local") return;
    const transferId = `dl-${Date.now()}`;
    await downloadTransfer.run({
      transferId,
      reportsProgress: connection.type === "ssh",
      action: () => downloadFileToFolder(connection, path, transferId),
      describeDone: (dest) => (dest === null ? null : `Saved to ${dest}`),
    });
  }

  return (
    <>
      <ToolbarButton
        label={openLabel}
        tooltip={transferTooltip(openTransfer.state, openLabel)}
        disabled={openTransfer.pending}
        onClick={() => void handleOpen()}
        className={cn(openTransfer.state.status === "error" && "text-destructive")}
      >
        <TransferIcon state={openTransfer.state} idle={<ExternalLink className="size-3.5" />} />
      </ToolbarButton>
      {connection.type !== "local" && (
        <ToolbarButton
          label="Download to…"
          tooltip={transferTooltip(downloadTransfer.state, "Download to…")}
          disabled={downloadTransfer.pending}
          onClick={() => void handleDownload()}
          className={cn(
            downloadTransfer.state.status === "error" && "text-destructive",
            downloadTransfer.state.status === "done" && "text-emerald-600",
          )}
        >
          <TransferIcon state={downloadTransfer.state} idle={<FolderDown className="size-3.5" />} />
        </ToolbarButton>
      )}
    </>
  );
}
