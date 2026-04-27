import { useState } from "react";
import { Shield, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/ui/button";

interface PermissionPromptProps {
  requestId: string;
  payload: Record<string, unknown>;
  onRespond: (requestId: string, allowed: boolean) => void;
}

function toolLabel(payload: Record<string, unknown>): string {
  const tool = payload.tool as string | undefined;
  if (!tool) return "Action";
  const map: Record<string, string> = {
    write_file: "Write file",
    read_file: "Read file",
    execute_command: "Run command",
    bash: "Run command",
    shell: "Run command",
    edit_file: "Edit file",
    delete_file: "Delete file",
    create_file: "Create file",
  };
  return map[tool] ?? tool;
}

function toolSubLabel(payload: Record<string, unknown>): string {
  const tool = (payload.tool as string | undefined) ?? "";
  if (/command|bash|shell/i.test(tool)) return "Agent wants to run a command";
  if (/file|edit|write|read|create|delete/i.test(tool)) return "Agent wants to access or modify a file";
  return "Agent wants to perform an action";
}

function targetSummary(payload: Record<string, unknown>): string {
  const path = payload.path as string | undefined;
  const command = payload.command as string | undefined;
  const cmd = payload.cmd as string | undefined;
  return path ?? command ?? cmd ?? JSON.stringify(payload);
}

export function PermissionPrompt({ requestId, payload, onRespond }: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-t border-border bg-background px-3.5 py-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-8 h-8 rounded-md bg-accent/10 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Shield className="w-4 h-4 text-accent" />
        </div>
        <div>
          <div className="text-sm font-semibold text-foreground">{toolLabel(payload)}</div>
          <div className="text-xs text-muted-foreground">{toolSubLabel(payload)}</div>
        </div>
      </div>

      <div className="bg-muted/40 border border-border rounded-md px-3 py-2 mb-2.5 flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-foreground/80 truncate flex-1">
          {targetSummary(payload)}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-accent hover:text-accent/80 flex-shrink-0 transition-colors"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {expanded ? "hide" : "view full"}
        </button>
      </div>

      {expanded && (
        <pre className="bg-muted rounded-md p-2.5 text-[11px] font-mono text-muted-foreground overflow-x-auto mb-2.5 border border-border">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}

      <div className="flex gap-2">
        <Button variant="destructive" size="sm" onClick={() => onRespond(requestId, false)}>
          Deny
        </Button>
        <Button variant="accent" size="sm" onClick={() => onRespond(requestId, true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
