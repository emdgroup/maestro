import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type InstallType = "appimage" | "package" | "native";

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
  installType: InstallType | null;
  setStatus: (status: UpdateStatus) => void;
  setLastChecked: (date: Date) => void;
  setInstallType: (type: InstallType) => void;
}

// Module-level — non-serializable, cannot go in Zustand
let pendingUpdate: Update | null = null;
let cachedInstallType: InstallType | null = null;

const useUpdaterStore = create<UpdaterState>((set) => ({
  status: { phase: "idle" },
  lastChecked: (() => {
    const stored = localStorage.getItem("updater:lastChecked");
    return stored ? new Date(stored) : null;
  })(),
  installType: null,
  setStatus: (status) => set({ status }),
  setLastChecked: (date) => set({ lastChecked: date }),
  setInstallType: (installType) => set({ installType }),
}));

async function resolveInstallType(): Promise<InstallType> {
  if (cachedInstallType !== null) return cachedInstallType;
  cachedInstallType = await invoke<InstallType>("get_linux_install_type");
  useUpdaterStore.getState().setInstallType(cachedInstallType);
  return cachedInstallType;
}

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
  const { status, lastChecked, installType } = useUpdaterStore();
  const isPackageInstall = installType === "package";

  async function checkForUpdates(autoUpdate: boolean) {
    const store = useUpdaterStore.getState();
    const type = await resolveInstallType();
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
      if (autoUpdate && type !== "package") {
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

  async function downloadPackage(version: string) {
    // ponytail: open browser URL — browser handles progress, destination, resume
    const url = `https://github.com/emdgroup/maestro/releases/download/v${version}/maestro_${version}_amd64.deb`;
    await openUrl(url);
  }

  return { status, lastChecked, isPackageInstall, checkForUpdates, install, downloadPackage };
}
