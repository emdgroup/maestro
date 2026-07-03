import { openPath } from "@tauri-apps/plugin-opener";
import { tempDir } from "@tauri-apps/api/path";
import { api } from "@/lib/tauri-utils";
import type { ConnectionKey } from "@/types/bindings";

export async function openFileWithConnection(
  connection: ConnectionKey,
  absolutePath: string,
  opts?: { sshConnectionId?: number; wslDistroName?: string; transferId?: string },
): Promise<void> {
  if (connection.type === "local") {
    await openPath(absolutePath);
  } else if (connection.type === "ssh" && opts?.sshConnectionId != null) {
    const basename = absolutePath.split("/").pop() ?? "file";
    const tmp = await tempDir();
    const localPath = tmp + "maestro-" + basename;
    const transferId = opts.transferId ?? `open-${basename}`;
    await api.sftpDownload(opts.sshConnectionId, absolutePath, localPath, transferId);
    await openPath(localPath);
  } else if (connection.type === "wsl" && opts?.wslDistroName) {
    const winPath = "\\\\wsl$\\" + opts.wslDistroName + absolutePath.replace(/\//g, "\\");
    await openPath(winPath);
  }
}
