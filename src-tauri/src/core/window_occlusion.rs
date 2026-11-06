//! Tell the frontend when the main window cannot be seen, so it can pause its animations.
//!
//! WebView2 is never told: wry skips `SIZE_MINIMIZED` in its resize handler and has no occlusion
//! tracking, so a minimized window, or one behind a maximized window, still reports
//! `document.visibilityState` as `visible` and keeps compositing every infinite CSS animation.
//! Measured on Home with the bubbles running: 4.2% of a 22-core machine minimized, 4.5% covered,
//! against 0.1% with animation off.
//!
//! Polled rather than hooked: Windows has no occlusion notification, and walking the windows above
//! ours twice a second costs nothing next to the frames it saves.

/// Emitted with `true` when the window goes out of sight and `false` when it comes back.
pub const WINDOW_HIDDEN_EVENT: &str = "window-hidden";

#[cfg(windows)]
pub fn watch(app: &tauri::AppHandle) {
    use tauri::Manager;

    let Some(hwnd) = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
    else {
        log::warn!("No main window to watch for occlusion");
        return;
    };
    // HWND is a raw pointer and not Send; the handle itself stays valid for the window's life.
    let raw = hwnd.0 as isize;
    let app = app.clone();
    std::thread::spawn(move || {
        let hwnd = windows::Win32::Foundation::HWND(raw as *mut _);
        let mut hidden = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let now = unsafe { win32::is_hidden(hwnd) };
            if now != hidden {
                hidden = now;
                super::emit_or_log(&app, WINDOW_HIDDEN_EVENT, hidden);
            }
        }
    });
}

#[cfg(not(windows))]
pub fn watch(_app: &tauri::AppHandle) {}

#[cfg(windows)]
mod win32 {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowLongW, GetWindowRect, IsIconic, IsWindowVisible, GWL_EXSTYLE,
        GW_HWNDPREV, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };

    /// Minimized, or entirely inside one opaque window above it in the Z-order.
    ///
    /// ponytail: only a single covering window counts, so a window hidden by two tiled ones keeps
    /// animating. Union the rects with a region if that case turns out to matter.
    pub unsafe fn is_hidden(hwnd: HWND) -> bool {
        unsafe {
            // Before the frontend calls `show()` the window is not visible, and must not count as
            // hidden: that would pause the startup animations it is about to reveal.
            if !IsWindowVisible(hwnd).as_bool() {
                return false;
            }
            if IsIconic(hwnd).as_bool() {
                return true;
            }
            let ours = bounds(hwnd);
            let mut above = GetWindow(hwnd, GW_HWNDPREV);
            while let Ok(other) = above {
                if is_opaque(other) && contains(&bounds(other), &ours) {
                    return true;
                }
                above = GetWindow(other, GW_HWNDPREV);
            }
            false
        }
    }

    /// Visible, on this desktop, and not see-through. Layered windows are skipped whole: some are
    /// opaque, but treating an overlay as a cover would freeze a window the user can see.
    unsafe fn is_opaque(hwnd: HWND) -> bool {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return false;
            }
            let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if style & (WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0) != 0 {
                return false;
            }
            // Windows on another virtual desktop, and suspended UWP frames, are visible but cloaked.
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut _,
                size_of::<u32>() as u32,
            );
            cloaked == 0
        }
    }

    /// What the window actually paints, without the invisible resize border `GetWindowRect`
    /// includes on Windows 10 and later.
    unsafe fn bounds(hwnd: HWND) -> RECT {
        unsafe {
            let mut rect = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rect as *mut RECT as *mut _,
                size_of::<RECT>() as u32,
            )
            .is_err()
            {
                let _ = GetWindowRect(hwnd, &mut rect);
            }
            rect
        }
    }

    fn contains(outer: &RECT, inner: &RECT) -> bool {
        outer.left <= inner.left
            && outer.top <= inner.top
            && outer.right >= inner.right
            && outer.bottom >= inner.bottom
    }
}
