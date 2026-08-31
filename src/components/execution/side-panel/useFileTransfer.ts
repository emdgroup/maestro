import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/// Nothing is shown until a transfer has run this long, so copying a small file — the common case
/// on a container or a distro — does not flash an indicator for a few frames.
const APPEAR_AFTER_MS = 300;

/// How long a success confirmation stays before the button returns to its resting icon. Failures
/// are not on a timer: they stay until the next attempt.
const CONFIRM_FOR_MS = 2500;

export type TransferState =
  | { status: "idle" }
  | { status: "busy"; progress: number | null }
  | { status: "done"; detail: string }
  | { status: "error"; detail: string };

export interface RunOptions<T> {
  /// Channel `sftp://transfer-progress/` reports on. Ignored unless `reportsProgress`.
  transferId: string;
  /// Only SSH counts bytes. A distro copy and `docker cp` are each one opaque call, so they get
  /// the indeterminate ring rather than a percentage frozen at zero.
  reportsProgress: boolean;
  action: () => Promise<T>;
  /// Tooltip text once it succeeds, or null to go quiet. Open returns null — the file appearing on
  /// screen is its own confirmation — while a download says where it landed, which is otherwise
  /// invisible.
  describeDone?: (result: T) => string | null;
}

/// Drives the transfer indicator on the panel toolbars: one action at a time, progress when the
/// transport reports any, and the backend's own message when it fails.
export function useFileTransfer() {
  const [state, setState] = useState<TransferState>({ status: "idle" });
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  // Kept apart because their lifetimes are opposite: the appear timer is cancelled when the
  // transfer settles, while the confirm timer is only set at that moment and has to outlive it.
  const appearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback((ref: React.RefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current !== null) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (appearTimer.current !== null) clearTimeout(appearTimer.current);
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const run = useCallback(
    async <T>(options: RunOptions<T>): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      // Drop a confirmation still on screen from the previous run.
      clearTimer(confirmTimer);

      // Held outside state so a progress event that lands before the delay elapses is not lost.
      let progress: number | null = null;
      appearTimer.current = setTimeout(
        () => setState({ status: "busy", progress }),
        APPEAR_AFTER_MS,
      );

      const unlisten = options.reportsProgress
        ? await listen<{ bytes_transferred: number; total_bytes: number }>(
            `sftp://transfer-progress/${options.transferId}`,
            (event) => {
              progress =
                event.payload.total_bytes > 0
                  ? Math.round((event.payload.bytes_transferred / event.payload.total_bytes) * 100)
                  : 0;
              setState((current) =>
                current.status === "busy" ? { status: "busy", progress } : current,
              );
            },
          )
        : null;

      try {
        const result = await options.action();
        const detail = options.describeDone?.(result) ?? null;
        if (detail === null) {
          setState({ status: "idle" });
        } else {
          setState({ status: "done", detail });
          confirmTimer.current = setTimeout(() => setState({ status: "idle" }), CONFIRM_FOR_MS);
        }
      } catch (error) {
        // `api` rejects with the string the Rust command returned, so this is the actual reason —
        // "No such container", a wslpath failure — rather than a generic label.
        setState({
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimer(appearTimer);
        unlisten?.();
        inFlight.current = false;
        setPending(false);
      }
    },
    [clearTimer],
  );

  return { state, run, pending };
}

/// Tooltip for a toolbar button, falling back to `idleText` when nothing is in flight.
export function transferTooltip(state: TransferState, idleText: string): string {
  switch (state.status) {
    case "busy":
      return state.progress === null ? "Copying…" : `Copying ${state.progress}%`;
    case "done":
    case "error":
      return state.detail;
    default:
      return idleText;
  }
}
