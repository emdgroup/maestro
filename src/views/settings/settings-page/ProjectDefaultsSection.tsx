import { Controller } from "react-hook-form";
import type { Control } from "react-hook-form";
import { BrandIcon, hasBrandIcon } from "@/components/common/brand-icon/BrandIcon";
import { Label } from "@/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { Bot, RotateCcw } from "lucide-react";
import type { DiscoveredAgent } from "@/types/bindings";

export interface ProjectSettingsFormData {
  default_agent: string;
  reopen_sessions: boolean;
  startup_tab: string;
}

interface ProjectDefaultsSectionProps {
  control: Control<ProjectSettingsFormData>;
  agents: DiscoveredAgent[];
  agentsLoading: boolean;
}

export function ProjectDefaultsSection({
  control,
  agents,
  agentsLoading,
}: ProjectDefaultsSectionProps) {
  return (
    <>
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Bot className="w-4 h-4 text-muted-foreground" />
          Default Agent
        </h3>

        {/* Default Agent */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Default Agent</Label>
          <Controller
            name="default_agent"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(v) => field.onChange(v ?? "")}
                disabled={agentsLoading}
              >
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue
                    placeholder={agentsLoading ? "Loading agents…" : "None (use session default)"}
                  >
                    {field.value === ""
                      ? "None (use session default)"
                      : (agents.find((a) => a.id === field.value)?.name ?? field.value)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None (use session default)</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      <div className="flex items-center gap-2">
                        {hasBrandIcon(agent.id) ? (
                          <BrandIcon slug={agent.id} className="w-4 h-4 shrink-0" />
                        ) : (
                          agent.icon && (
                            <img
                              src={agent.icon}
                              className="w-4 h-4 rounded-sm shrink-0 dark:filter-[invert(1)]"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                              alt="agent icon"
                            />
                          )
                        )}
                        {agent.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-xs text-muted-foreground">
            Used for new sessions and auto-assigned tasks
          </p>
        </div>
      </div>

      {/* Startup Behavior Card */}
      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-muted-foreground" />
          Startup
        </h3>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">Reopen Previous Sessions</Label>
            <p className="text-xs text-muted-foreground">
              Automatically restore agent sessions from your last session
            </p>
          </div>
          <Controller
            name="reopen_sessions"
            control={control}
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                className="data-unchecked:bg-muted data-unchecked:border-border/50"
              />
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Default Tab</Label>
          <Controller
            name="startup_tab"
            control={control}
            render={({ field }) => (
              <Select value={field.value} onValueChange={(v) => field.onChange(v ?? "")}>
                <SelectTrigger className="w-full bg-muted">
                  <SelectValue>
                    {field.value === "" || field.value === "kanban"
                      ? "Tasks (default)"
                      : field.value === "agents"
                        ? "Agents"
                        : field.value === "worktrees"
                          ? "Worktrees"
                          : "Settings"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Tasks (default)</SelectItem>
                  <SelectItem value="agents">Agents</SelectItem>
                  <SelectItem value="worktrees">Worktrees</SelectItem>
                  <SelectItem value="settings">Settings</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-xs text-muted-foreground">
            Which tab opens first when you enter this project
          </p>
        </div>
      </div>
    </>
  );
}
