import { join, tempDir } from "@tauri-apps/api/path";
import { open as openDirPicker } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri-utils";
import type { ConnectionKey } from "@/types/bindings";

export async function openFileWithConnection(
  connection: ConnectionKey,
  absolutePath: string,
  opts?: { sshConnectionId?: number; wslDistroName?: string; transferId?: string },
): Promise<void> {
  if (connection.type === "local") {
    await api.openPathNative(absolutePath);
  } else if (connection.type === "ssh" && opts?.sshConnectionId != null) {
    const basename = absolutePath.split("/").pop() ?? "file";
    const tmp = await tempDir();
    const localPath = await join(tmp, "maestro", basename);
    const transferId = opts.transferId ?? `open-${basename}`;
    await api.sftpDownload(opts.sshConnectionId, absolutePath, localPath, transferId);
    await api.openPathNative(localPath);
  } else if (connection.type === "wsl" && opts?.wslDistroName) {
    const winPath = "\\\\wsl$\\" + opts.wslDistroName + absolutePath.replace(/\//g, "\\");
    await api.openPathNative(winPath);
  }
}

export async function downloadFileToFolder(
  sshConnectionId: number,
  absolutePath: string,
  transferId: string,
): Promise<void> {
  const chosen = await openDirPicker({ directory: true });
  if (!chosen) return;
  const basename = absolutePath.split("/").pop() ?? "file";
  const destPath = await join(chosen as string, basename);
  await api.sftpDownload(sshConnectionId, absolutePath, destPath, transferId);
}
