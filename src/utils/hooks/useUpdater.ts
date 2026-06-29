import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type UpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "upToDate" }
  | { phase: "available"; version: string; notes: string | null }
  | { phase: "downloading"; progress: number; version: string }
  | { phase: "error"; message: string };

interface UpdaterState {
  status: UpdateStatus;
  lastChecked: Date | null;
  setStatus: (status: UpdateStatus) => void;
  setLastChecked: (date: Date) => void;
}

// Module-level Update object — non-serializable, cannot go in Zustand
let pendingUpdate: Update | null = null;

const useUpdaterStore = create<UpdaterState>((set) => ({
  status: { phase: "idle" },
  lastChecked: (() => {
    const stored = localStorage.getItem("updater:lastChecked");
    return stored ? new Date(stored) : null;
  })(),
  setStatus: (status) => set({ status }),
  setLastChecked: (date) => set({ lastChecked: date }),
}));

async function doFullInstall(): Promise<void> {
  const store = useUpdaterStore.getState();
  const update = pendingUpdate;
  if (!update) return;

  const version = update.version;
  let totalBytes = 0;
  let downloadedBytes = 0;
  await update.download((event) => {
    if (event.event === "Started") {
      totalBytes = event.data.contentLength ?? 0;
      store.setStatus({ phase: "downloading", progress: 0, version });
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      store.setStatus({ phase: "downloading", progress: pct, version });
    }
  });
  await pendingUpdate?.install();
  await relaunch();
}

export function useUpdater() {
  const { status, lastChecked } = useUpdaterStore();

  async function checkForUpdates(autoUpdate: boolean) {
    const store = useUpdaterStore.getState();
    store.setStatus({ phase: "checking" });
    try {
      const update = await check();
      const now = new Date();
      store.setLastChecked(now);
      localStorage.setItem("updater:lastChecked", now.toISOString());

      if (!update) {
        store.setStatus({ phase: "upToDate" });
        return;
      }

      pendingUpdate = update;
      if (autoUpdate) {
        await doFullInstall();
      } else {
        store.setStatus({
          phase: "available",
          version: update.version,
          notes: update.body ?? null,
        });
      }
    } catch (e) {
      store.setStatus({ phase: "error", message: String(e) });
    }
  }

  async function install() {
    if (pendingUpdate) {
      await doFullInstall();
      return;
    }
    // pendingUpdate was lost (e.g. store rehydrated) — re-check then install
    const store = useUpdaterStore.getState();
    store.setStatus({ phase: "checking" });
    try {
      const update = await check();
      if (!update) {
        store.setStatus({ phase: "upToDate" });
        return;
      }
      pendingUpdate = update;
      await doFullInstall();
    } catch (e) {
      store.setStatus({ phase: "error", message: String(e) });
    }
  }

  return { status, lastChecked, checkForUpdates, install };
}
