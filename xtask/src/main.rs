use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

const REMOTE_TARGET: &str = "x86_64-unknown-linux-gnu";

fn main() {
    let host_target = env::var("TAURI_ENV_TARGET_TRIPLE").unwrap_or_else(|_| detect_host_target());

    let resources = Path::new("src-tauri/resources");
    fs::create_dir_all(resources.join("remote")).expect("Failed to create resources/remote dir");

    println!("[xtask] building maestro-server for local: {host_target}");
    cargo_build_server(&host_target);

    let ext = if host_target.contains("windows") { ".exe" } else { "" };
    let local_src = format!("target/{host_target}/release/maestro-server{ext}");
    let local_dst = resources.join(format!("maestro-server{ext}"));
    fs::copy(&local_src, &local_dst)
        .unwrap_or_else(|e| panic!("copy {local_src} → {}: {e}", local_dst.display()));

    if host_target != REMOTE_TARGET {
        println!("[xtask] building maestro-server for remote: {REMOTE_TARGET}");
        cargo_build_server(REMOTE_TARGET);
    }
    let remote_src = format!("target/{REMOTE_TARGET}/release/maestro-server");
    let remote_dst = resources
        .join("remote")
        .join(format!("maestro-server-{REMOTE_TARGET}"));
    fs::copy(&remote_src, &remote_dst)
        .unwrap_or_else(|e| panic!("copy {remote_src} → {}: {e}", remote_dst.display()));

    println!("[xtask] done");
}

fn cargo_build_server(target: &str) {
    let needs_xwin = target.contains("windows") && !cfg!(target_os = "windows");

    let status = if needs_xwin {
        Command::new("cargo")
            .args(["xwin", "build", "-p", "maestro-server", "--release", "--target", target])
            .status()
            .expect("failed to run cargo xwin")
    } else {
        Command::new("cargo")
            .args(["build", "-p", "maestro-server", "--release", "--target", target])
            .status()
            .expect("failed to run cargo")
    };
    if !status.success() {
        panic!("cargo build failed for target {target}");
    }
}

fn detect_host_target() -> String {
    let output = Command::new("rustc")
        .args(["-vV"])
        .output()
        .expect("failed to run rustc -vV");
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|l| l.starts_with("host:"))
        .map(|l| l.trim_start_matches("host:").trim().to_string())
        .expect("could not detect host target from rustc -vV")
}
