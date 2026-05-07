fn main() {
    // Tauri validates resource glob patterns at compile time, before beforeBundleCommand runs.
    // Create empty stubs so the globs match during `cargo build`.
    let stubs = [
        "resources/maestro-server",
        "resources/remote/maestro-server-x86_64-unknown-linux-gnu",
    ];
    for path in stubs {
        let p = std::path::Path::new(path);
        if !p.exists() {
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::File::create(p).ok();
        }
    }
    tauri_build::build()
}
