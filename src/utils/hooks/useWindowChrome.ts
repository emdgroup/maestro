import { useSettings } from "@/services/settings.service";
import { isMacOS } from "@/lib/platform";

/**
 * Whether Maestro draws its own title bar buttons and resize borders, rather than the OS.
 *
 * False on macOS regardless of the setting, and false anywhere the user has asked for the system
 * title bar. The Rust side applies the same setting to the window itself — see
 * `settings::handlers::apply_window_frame` — so this only governs what the frontend renders on top.
 */
export function useWindowChrome(): boolean {
  const { data } = useSettings();
  return !isMacOS && !(data?.native_window_frame ?? false);
}
