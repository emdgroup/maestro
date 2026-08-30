/**
 * macOS always uses its native title bar, so the frameless chrome and its settings toggle are
 * suppressed there. Windows and Linux are frameless by default and can opt back into the OS frame.
 *
 * Read from the user agent rather than `@tauri-apps/plugin-os`: the webview is ours, the answer
 * cannot change at runtime, and the plugin would cost a Rust dependency and a capability for one
 * boolean.
 */
export const isMacOS = /Mac/.test(navigator.userAgent);
