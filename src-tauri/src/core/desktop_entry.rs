//! Give an AppImage the desktop entry Linux needs to show its icon.
//!
//! GNOME resolves a window's icon by matching the window's `app_id` (Wayland) or `WM_CLASS` (X11)
//! against `.desktop` files installed under `XDG_DATA_DIRS`. Both of those are GTK's `prgname`,
//! which is the binary name — `Maestro`. An AppImage installs nothing, so nothing matches and the
//! dock falls back to a generic icon; the entry and icon shipped *inside* the AppImage are never
//! looked at, because the desktop only searches installed locations.
//!
//! Writing the entry into the user's own data directory is what AppImageLauncher and Gear Lever do,
//! minus the third-party tool. The `.deb` already ships one and development builds are launched
//! from a path that will not exist tomorrow, so this only runs when `$APPIMAGE` is set — the
//! AppImage runtime sets it to the absolute path of the running image.

/// Name under which the desktop expects to find us.
///
/// Must stay equal to `productName` in `tauri.conf.json`: that is what the bundled binary is
/// called, so it is what GTK reports as `prgname`, and the desktop entry is only found if its file
/// name matches. `CARGO_PKG_NAME` is the crate name (`maestro`, lower case) and is *not* it.
#[cfg(target_os = "linux")]
const APP_NAME: &str = "Maestro";

/// Escape a path for the `Exec` key, which is `"`-quoted so that spaces survive.
///
/// The desktop entry spec reserves `"`, `` ` ``, `$` and `\` inside a quoted argument.
#[cfg(target_os = "linux")]
fn quote_exec(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for ch in path.chars() {
        if matches!(ch, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

#[cfg(target_os = "linux")]
fn desktop_entry(exec_path: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={APP_NAME}\n\
         Comment={}\n\
         Exec={}\n\
         Icon={APP_NAME}\n\
         Terminal=false\n\
         Categories=Development;\n\
         StartupWMClass={APP_NAME}\n",
        env!("CARGO_PKG_DESCRIPTION"),
        quote_exec(exec_path)
    )
}

/// `$XDG_DATA_HOME`, or `~/.local/share`. A relative `XDG_DATA_HOME` is invalid per the spec and
/// treated as unset rather than resolved against the working directory.
#[cfg(target_os = "linux")]
fn data_home() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .map(|home| home.join(".local/share"))
        })
}

/// Write the entry and icon if they are missing or out of date. Never fails the caller: an
/// unwritable data directory costs an icon, not a launch.
#[cfg(target_os = "linux")]
pub fn install_for_appimage() {
    let Some(appimage) = std::env::var_os("APPIMAGE") else {
        return;
    };
    // A non-UTF-8 path cannot be written into `Exec` without mangling it, and a mangled `Exec` is
    // worse than no entry: the launcher would appear and fail to start anything.
    let Some(appimage) = appimage.to_str().filter(|path| !path.is_empty()) else {
        log::warn!("APPIMAGE is empty or not valid UTF-8; skipping desktop integration");
        return;
    };

    let Some(data_home) = data_home() else {
        log::warn!("Neither XDG_DATA_HOME nor HOME is set; skipping desktop integration");
        return;
    };

    // The icon name in the entry is bare (`Icon=Maestro`), so it is resolved through the icon
    // theme and has to sit in the hicolor hierarchy rather than next to the entry.
    let icon = data_home.join(format!("icons/hicolor/256x256/apps/{APP_NAME}.png"));
    if !icon.exists() {
        if let Err(error) = write_file(&icon, include_bytes!("../../icons/128x128@2x.png")) {
            log::warn!("Could not write {}: {error}", icon.display());
            return;
        }
        log::info!("Installed desktop icon at {}", icon.display());
    }

    let entry_path = data_home.join(format!("applications/{APP_NAME}.desktop"));
    let entry = desktop_entry(appimage);
    // Rewritten rather than skipped when it differs, so moving or renaming the AppImage fixes the
    // stale `Exec` on the next launch.
    if std::fs::read_to_string(&entry_path).is_ok_and(|existing| existing == entry) {
        return;
    }
    match write_file(&entry_path, entry.as_bytes()) {
        Ok(()) => log::info!("Installed desktop entry at {}", entry_path.display()),
        Err(error) => log::warn!("Could not write {}: {error}", entry_path.display()),
    }
}

#[cfg(target_os = "linux")]
fn write_file(path: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)
}

#[cfg(not(target_os = "linux"))]
pub fn install_for_appimage() {}

// The unit under test is Linux-only; CI runs `cargo test -p maestro --lib` on Linux.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn exec_is_quoted_and_escaped() {
        assert_eq!(
            quote_exec("/opt/My Apps/Maestro.AppImage"),
            "\"/opt/My Apps/Maestro.AppImage\""
        );
        assert_eq!(quote_exec(r#"/tmp/a"b$c\d"#), r#""/tmp/a\"b\$c\\d""#);
    }

    #[test]
    fn entry_matches_the_window_and_the_icon() {
        let entry = desktop_entry("/opt/Maestro.AppImage");
        // These three are the whole point: the file name, the WM class and the icon name all have
        // to agree with the binary name for the desktop to find the icon.
        assert!(entry.contains("StartupWMClass=Maestro\n"));
        assert!(entry.contains("Icon=Maestro\n"));
        assert!(entry.contains("Exec=\"/opt/Maestro.AppImage\"\n"));
    }
}
