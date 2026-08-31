import { Bell } from "lucide-react";
import { Switch } from "@/ui/switch";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import type { AppSettings } from "@/types/bindings";

type ToggleKey = "notify_on_done" | "notify_on_input_needed" | "notify_on_failure";

const TOGGLES: Array<{ key: ToggleKey; label: string; hint: string }> = [
  { key: "notify_on_done", label: "Agent finished", hint: "A session ended its turn normally" },
  {
    key: "notify_on_input_needed",
    label: "Agent needs you",
    hint: "A permission prompt, a question, or a sign-in",
  },
  {
    key: "notify_on_failure",
    label: "Agent failed",
    hint: "A session stopped on an error, a refusal, or a limit",
  },
];

export function NotificationsSection() {
  const { data: appSettings } = useSettings();
  const saveAppSettings = useSaveSettings({ successToast: false });

  async function handleToggle(key: ToggleKey, checked: boolean) {
    if (!appSettings) return;
    // Asked here rather than at startup: macOS shows a system dialog, and it only makes sense
    // once the user has said they want notifications.
    if (checked && !(await isPermissionGranted()) && (await requestPermission()) !== "granted") {
      return;
    }
    saveAppSettings.mutate({
      ...appSettings,
      [key]: checked,
      updated_at: new Date().toISOString(),
    } as AppSettings);
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Bell className="w-4 h-4 text-muted-foreground" />
        Notifications
      </h3>

      <p className="text-xs text-muted-foreground">
        Only sent while Maestro is in the background. The window always asks for your attention when
        a session needs you, whether or not these are on.
      </p>

      <div className="space-y-3">
        {TOGGLES.map(({ key, label, hint }) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{label}</div>
              <div className="text-xs text-muted-foreground">{hint}</div>
            </div>
            <Switch
              tone="accent"
              checked={appSettings?.[key] ?? false}
              onCheckedChange={(checked) => void handleToggle(key, checked)}
              className="data-unchecked:bg-muted data-unchecked:border-border/50"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
