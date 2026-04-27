import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";

export type PermissionMode = "ask" | "auto" | "plan";

export const CLAUDE_MODELS = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]["id"];

interface SessionToolbarProps {
  modelId: ClaudeModelId;
  permissionMode: PermissionMode;
  onModelChange: (id: ClaudeModelId) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

export function SessionToolbar({
  modelId,
  permissionMode,
  onModelChange,
  onPermissionModeChange,
}: SessionToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-1.5 border-t border-border/30 bg-background">
      <Select value={modelId} onValueChange={(v) => onModelChange(v as ClaudeModelId)}>
        <SelectTrigger className="h-6 text-[11px] w-auto px-2 gap-1 border-border/40 bg-transparent text-muted-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLAUDE_MODELS.map((m) => (
            <SelectItem key={m.id} value={m.id} className="text-xs">
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
    </div>
  );
}
