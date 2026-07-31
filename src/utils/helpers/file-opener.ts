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

/// Whether [openFileWithConnection] stages a copy on the host before opening it, rather than
/// opening the file where it already lives. Lives here rather than in the callers so the answer
/// cannot drift from the branches below that decide it.
export function opensViaHostCopy(connection: ConnectionKey): boolean {
  return connection.type === "ssh" || connection.type === "docker";
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

/// Copy a file off whichever machine the connection names into a folder the user picks.
///
/// `transferId` names the channel `sftp://transfer-progress/` reports on, and only SSH reports:
/// the distro copy and `docker cp` are each one opaque call with no byte counts to forward.
///
/// Returns where the file landed, or null when the folder picker was dismissed — the caller needs
/// to tell those apart to avoid confirming a copy that never happened.
export async function downloadFileToFolder(
  connection: ConnectionKey,
  absolutePath: string,
  transferId: string,
): Promise<string | null> {
  const chosen = await openDirPicker({ directory: true });
  if (!chosen) return null;
  const basename = absolutePath.split("/").pop() ?? "file";
  const destPath = await join(chosen as string, basename);

  if (connection.type === "ssh") {
    await api.sftpDownload(connection.id, absolutePath, destPath, transferId);
  } else if (connection.type === "wsl") {
    await api.wslDownloadFile(connection.id, absolutePath, destPath);
  } else if (connection.type === "docker") {
    await api.dockerDownloadFile(connection.id, absolutePath, destPath);
  } else {
    // Local has nothing to copy from — callers hide the action rather than reaching this.
    throw new Error(`Cannot download '${absolutePath}' over this ${connection.type} connection`);
  }
  return destPath;
}
