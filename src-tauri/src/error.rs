// Error handling: All IPC handlers use Result<T, String> for Tauri serialization.
// No custom error type needed — errors are mapped to descriptive strings at each call site.
