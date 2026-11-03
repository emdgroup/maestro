import { useEffect, useReducer, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdater } from "@/hooks/useUpdater";
import { useSettings, useSaveSettings } from "@/services/settings.service";

function formatLastChecked(date: Date | null): string {
  if (!date) return "Never";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "Just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return "1 hour ago";
  return `${hours} hours ago`;
}

/** This build's version, `…` until Tauri answers. */
export function useAppVersion(): string {
  const [appVersion, setAppVersion] = useState("…");
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  return appVersion;
}

/** What `UpdateCard` and `UpdateStrip` both show: the updater, the version and auto-update. */
export function useUpdatePanel() {
  const updater = useUpdater();
  const appVersion = useAppVersion();
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });
  const autoUpdate = appSettings?.auto_update ?? false;

  // The label is relative to the wall clock, so what goes stale is the current time, not
  // `lastChecked`. The timer re-renders every 30s and the label is derived below.
  const [, relabel] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(relabel, 30_000);
    return () => clearInterval(id);
  }, []);

  function setAutoUpdate(checked: boolean) {
    if (!appSettings) return;
    saveAppSettings.mutate({ ...appSettings, auto_update: checked });
  }

  return {
    ...updater,
    appVersion,
    autoUpdate,
    setAutoUpdate,
    lastCheckedLabel: formatLastChecked(updater.lastChecked),
    isChecking: updater.status.phase === "checking",
  };
}
