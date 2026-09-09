import { Bot, FolderGit2, LayoutDashboard, Palette } from "lucide-react";
import { useTheme } from "@/providers/ThemeProvider";
import { SwatchPicker } from "@/components/common/accent-color-picker/AccentColorPicker";
import { Label } from "@/ui/label";
import type { ProjectConfigRequest } from "@/types/bindings";
import { OptionTile } from "./OptionTile";

/**
 * The same icons and the same labels as the header's own tabs (`AppHeader.tsx`), so the choice is
 * made against what it will produce. `settings` is a legal stored value and still applies at
 * startup, but it is not offered — opening a project on its settings screen is not a preference
 * worth a tile, and a project already stored that way simply shows none selected.
 */
const STARTUP_TABS: { value: string | null; label: string; icon: typeof Bot }[] = [
  // Null rather than `kanban`: Tasks is where a project opens when nobody has chosen, and
  // `useProjectAgentIntro` reads any stored value as "this project has been configured" and
  // suppresses the first-run intro. Picking the default must not do that.
  { value: null, label: "Tasks", icon: LayoutDashboard },
  { value: "agents", label: "Agents", icon: Bot },
  { value: "worktrees", label: "Workspaces", icon: FolderGit2 },
];

interface ProjectAppearanceSectionProps {
  /** Null means no preference — the project opens on Tasks. */
  startupTab: string | null;
  /** Persists immediately, this section has no Save button behind it. */
  onChange: (patch: Partial<ProjectConfigRequest>) => void;
}

export function ProjectAppearanceSection({ startupTab, onChange }: ProjectAppearanceSectionProps) {
  const { isDark, projectAccentHue, setProjectAccentColor, globalAccentHue, systemAccentHue } =
    useTheme();

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
        <Palette className="w-4 h-4 text-muted-foreground" />
        Appearance
      </h3>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">This Project&apos;s Color</div>
          <div className="text-xs text-muted-foreground">
            Colors the header so you can tell projects apart at a glance
          </div>
        </div>
        <SwatchPicker
          title="Project Color"
          selectedHue={projectAccentHue}
          fallbackHue={globalAccentHue ?? systemAccentHue ?? 250}
          fallbackLabel="Global default"
          fallbackDescription="Follows the global default in Application → Appearance"
          isDark={isDark}
          onSelect={(hue) => void setProjectAccentColor(hue)}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">Opens On</Label>
        <div className="grid grid-cols-3 gap-2">
          {STARTUP_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <OptionTile
                key={tab.label}
                selected={startupTab === tab.value}
                onSelect={() => onChange({ startup_tab: tab.value })}
                className="flex flex-col items-center gap-1.5 text-center"
              >
                <Icon className="size-4.5" />
                <span className="text-xs font-medium leading-none">{tab.label}</span>
              </OptionTile>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Which tab this project opens on. Tasks is the default.
        </p>
      </div>
    </div>
  );
}
