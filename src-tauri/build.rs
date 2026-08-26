fn main() {
    tauri_build::build();

    link_windows_resource_into_tests();
}

/// Opt-in: give test binaries the Windows resource that `tauri_build::build()` links into bins
/// only. Enabled by setting `MAESTRO_TEST_MANIFEST=1`.
///
/// The resource carries the `Microsoft.Windows.Common-Controls` 6.0.0.0 manifest, and tauri-build
/// emits it as `cargo:rustc-link-arg-bins`, which cargo applies to bin targets and nothing else.
/// A test binary therefore has no manifest, so the loader binds the ComCtl32 5.82 in System32
/// rather than the v6 assembly — and 5.82 has no `TaskDialogIndirect`, which the dialog plugin
/// imports. Every test binary then dies at load with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)
/// before a single test runs, which also takes out `bun run tauri:gen` because that goes through
/// `cargo test generate_typescript_bindings`.
///
/// Why this is opt-in rather than always on: the narrow directive, `rustc-link-arg-tests`, is
/// rejected outright because cargo restricts it to `[[test]]` targets and this crate's tests are
/// the lib's own harness. The only directive that reaches that harness is `rustc-link-arg`, which
/// also hits bins — and a bin then gets the resource twice, which does *not* deduplicate:
/// `CVT1100: duplicate resource. type:VERSION` and the link fails with LNK1123. Since a broken
/// app build is far worse than tests needing a flag, the default is off.
///
/// So on Windows, run tests as:
///
/// ```text
/// MAESTRO_TEST_MANIFEST=1 cargo test --lib
/// ```
///
/// `--lib` is required, not a nicety: a bare `cargo test` also builds the bin's own test harness,
/// which is a bin target and so already carries the resource — adding it again fails the same way
/// a normal bin build would. Nothing is lost, because this crate has no `tests/` directory and no
/// tests in `main.rs`.
fn link_windows_resource_into_tests() {
    println!("cargo:rerun-if-env-changed=MAESTRO_TEST_MANIFEST");

    if std::env::var("MAESTRO_TEST_MANIFEST").as_deref() != Ok("1") {
        return;
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };

    // Skipping quietly when the file is absent keeps this from breaking the build if a future
    // tauri-build stops producing it, or names it something else.
    let resource = std::path::Path::new(&out_dir).join("resource.lib");
    if resource.exists() {
        println!("cargo:rustc-link-arg={}", resource.display());
    }
}
