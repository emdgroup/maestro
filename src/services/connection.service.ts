import { ipc } from "./ipc";
import type { SshConnection } from "@/types/bindings";

/**
 * Connection service providing type-safe operations for SSH connection management.
 * All SSH connection-related IPC calls are centralized here.
 */
export const connectionService = {
  /**
   * Connect to SSH without credentials (using saved config)
   */
  async connectSshWithoutCredentials(
    connectionName: string,
    projectPath?: string
  ): Promise<SshConnection> {
    return ipc.invoke<SshConnection>("connect_ssh_without_credentials", {
      connectionName,
      projectPath: projectPath || "",
    });
  },

  /**
   * Connect to SSH with password
   */
  async connectSshWithPassword(
    connectionName: string,
    password: string,
    projectPath?: string
  ): Promise<SshConnection> {
    return ipc.invoke<SshConnection>("connect_ssh_with_password", {
      connectionName,
      password,
      projectPath: projectPath || "",
    });
  },

  /**
   * Delete SSH connection
   */
  async deleteSshConnection(connectionId: string): Promise<void> {
    return ipc.invoke<void>("delete_ssh_connection", { connectionId });
  },

  /**
   * Rename SSH connection
   */
  async renameSshConnection(
    connectionId: string,
    newName: string
  ): Promise<void> {
    return ipc.invoke<void>("rename_ssh_connection", { connectionId, newName });
  },

  /**
   * Forget saved password for SSH connection
   */
  async forgetSavedPassword(connectionId: string): Promise<void> {
    return ipc.invoke<void>("forget_saved_password", { connectionId });
  },

  /**
   * List local directories (for file picker)
   */
  async listLocalDirectories(path: string): Promise<string[]> {
    return ipc.invoke<string[]>("list_local_directories", { path });
  },

  /**
   * List remote directories (for SSH file picker)
   */
  async listRemoteDirectories(
    connectionId: string,
    path: string
  ): Promise<string[]> {
    return ipc.invoke<string[]>("list_remote_directories", { connectionId, path });
  },

  /**
   * List available drives (for Windows)
   */
  async listDrives(): Promise<string[]> {
    return ipc.invoke<string[]>("list_drives");
  },

  /**
   * Get default file picker path
   */
  async getDefaultFilePickerPath(): Promise<string> {
    return ipc.invoke<string>("get_default_file_picker_path");
  },
};
