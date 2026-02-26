import { ipc } from "./ipc";
import type { AppSettings } from "@/types/bindings";

/**
 * Settings service providing type-safe operations for application settings.
 * All settings-related IPC calls are centralized here.
 */
export const settingsService = {
  /**
   * Get all application settings
   */
  async getSettings(): Promise<AppSettings> {
    return ipc.invoke<AppSettings>("get_settings");
  },

  /**
   * Save application settings
   */
  async saveSettings(settings: AppSettings): Promise<void> {
    return ipc.invoke<void>("save_settings", { settings });
  },

  /**
   * Get system accent color
   */
  async getSystemAccentColor(): Promise<number[]> {
    return ipc.invoke<number[]>("get_system_accent_color");
  },
};
