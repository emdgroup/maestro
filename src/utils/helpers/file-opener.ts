import { join, tempDir } from "@tauri-apps/api/path";
import { open as openDirPicker } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri-utils";
import type { ConnectionKey } from "@/types/bindings";

/// Where a remote file is staged so a host application can open it. The file is a copy: edits made
/// in whatever opens it do not travel back.
async function hostCopyPath(absolutePath: string): Promise<string> {
  const basename = absolutePath.split("/").pop() ?? "file";
  return join(await tempDir(), "maestro", basename);
}

export async function openFileWithConnection(
  connection: ConnectionKey,
  absolutePath: string,
  opts?: { sshConnectionId?: number; wslDistroName?: string; transferId?: string },
): Promise<void> {
  if (connection.type === "local") {
    await api.openPathNative(absolutePath);
  } else if (connection.type === "ssh" && opts?.sshConnectionId != null) {
    const basename = absolutePath.split("/").pop() ?? "file";
    const localPath = await hostCopyPath(absolutePath);
    const transferId = opts.transferId ?? `open-${basename}`;
    await api.sftpDownload(opts.sshConnectionId, absolutePath, localPath, transferId);
    await api.openPathNative(localPath);
  } else if (connection.type === "wsl" && opts?.wslDistroName) {
    // The distro is asked rather than prefixing \\wsl.localhost\ here, because a path under /mnt
    // is a file on this machine's own disk and should open from there, not through the share.
    const winPath = await api.wslToWindowsPath(opts.wslDistroName, absolutePath);
    await api.openPathNative(winPath);
  } else if (connection.type === "docker") {
    const localPath = await hostCopyPath(absolutePath);
    await api.dockerDownloadFile(connection.id, absolutePath, localPath);
    await api.openPathNative(localPath);
  } else {
    // Falling through used to resolve successfully having done nothing, which is indistinguishable
    // from a working open to every caller here. Reached when a WSL distro name has not loaded yet.
    throw new Error(`Cannot open '${absolutePath}' over this ${connection.type} connection yet`);
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
