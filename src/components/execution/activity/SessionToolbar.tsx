import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { TokenUsageIndicator } from "./TokenUsageIndicator";
import type { UsageState } from "./types";

export type PermissionMode = "ask" | "auto" | "plan";

export interface ModelOption {
  id: string;
  label: string;
}

interface SessionToolbarProps {
  models: ModelOption[];
  modelId: string;
  permissionMode: PermissionMode;
  usageState: UsageState | null;
  onModelChange: (id: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

export function SessionToolbar({
  models,
  modelId,
  permissionMode,
  usageState,
  onModelChange,
  onPermissionModeChange,
}: SessionToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-1.5 border-t border-border/30 bg-background">
      {models.length > 0 && (
        <Select value={modelId} onValueChange={(v) => v && onModelChange(v)}>
          <SelectTrigger className="h-6 text-[11px] w-auto px-2 gap-1 border-border/40 bg-transparent text-muted-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={permissionMode} onValueChange={(v) => onPermissionModeChange(v as PermissionMode)}>
        <SelectTrigger className="h-6 text-[11px] w-auto px-2 gap-1 border-border/40 bg-transparent text-muted-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask" className="text-xs">Ask before edits</SelectItem>
          <SelectItem value="auto" className="text-xs">Edit automatically</SelectItem>
          <SelectItem value="plan" className="text-xs">Plan mode</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex-1" />
      {usageState !== null && <TokenUsageIndicator usage={usageState} />}
    </div>
  );
}
