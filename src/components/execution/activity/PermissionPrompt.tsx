import { Shield, Pencil, Terminal, Eye, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { DynamicIcon } from "@/ui/dynamic-icon";
import { CommandLabel } from "./CommandLabel";
import { PlanPermissionOverlay } from "./PlanPermissionOverlay";
import { rowIcon } from "./ToolCallTimeline";
import {
  isAllowKind,
  extractOptions,
  extractTitle,
  extractBodyText,
  extractCommandText,
  isPlanPermission,
  isPlanToolCallItem,
  toolCallItemFromPayload,
} from "./permission-prompt-utils";
import type { PermissionOption } from "./permission-prompt-utils";

export { isAllowKind, extractBodyText, isPlanPermission, isPlanToolCallItem };
export type { PermissionOption };

interface PermissionPromptProps {
  requestId: string;
  payload: Record<string, unknown>;
  onRespond: (requestId: string, optionId: string | null) => void;
  fullHeight?: boolean;
}

function LegacyButtons({
  requestId,
  onRespond,
}: {
  requestId: string;
  onRespond: (requestId: string, optionId: string | null) => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="ghost" size="sm" onClick={() => onRespond(requestId, null)}>
        Deny
      </Button>
      <Button variant="accent" size="sm" onClick={() => onRespond(requestId, "allow")}>
        Allow
      </Button>
    </div>
  );
}

const TOOL_ICON_MAP: Record<string, React.ElementType> = {
  write_file: Pencil,
  edit_file: Pencil,
  create_file: Pencil,
  execute_command: Terminal,
  bash: Terminal,
  shell: Terminal,
  read_file: Eye,
  delete_file: Trash2,
};

export function PermissionPrompt({
  requestId,
  payload,
  onRespond,
  fullHeight,
}: PermissionPromptProps) {
  const title = extractTitle(payload);
  const bodyText = extractBodyText(payload);
  const command = extractCommandText(payload);
  const options = extractOptions(payload);

  if (fullHeight) {
    return (
      <PlanPermissionOverlay
        requestId={requestId}
        bodyText={bodyText}
        options={options}
        onRespond={onRespond}
      />
    );
  }

  // Same icon the stream row for this call will carry — `rowIcon` keys off kind, the
  // agent's tool name and the `mcp__` prefix, none of which the map below can see.
  // That map is the fallback for a legacy payload that sends `tool` and no `toolCall`.
  const item = toolCallItemFromPayload(payload);
  const toolName = payload.tool as string | undefined;
  const icon = item ? rowIcon(item) : (TOOL_ICON_MAP[toolName ?? ""] ?? Shield);

  return (
    <div className="rounded-[10px] border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent p-3.5 flex flex-col gap-2.5 shadow-[0_2px_8px_oklch(0%_0_0/0.08)]">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
          <DynamicIcon icon={icon} className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>

      {command && (
        <div className="px-2.5 py-2 bg-muted/50 rounded-md border border-border/50 max-h-[80px] overflow-y-auto custom-scrollbar">
          <CommandLabel command={command} />
        </div>
      )}

      {bodyText && bodyText !== command && (
        <div className="px-2.5 py-2 bg-muted/50 rounded-md border border-border/50 text-xs text-muted-foreground font-mono break-all whitespace-pre-wrap max-h-[80px] overflow-y-auto">
          {bodyText}
        </div>
      )}

      <div className="flex flex-wrap gap-2 justify-end">
        {options ? (
          options.map((opt) => (
            <Button
              key={opt.optionId}
              variant={isAllowKind(opt.kind) ? "accent" : "ghost"}
              size="sm"
              onClick={() => onRespond(requestId, opt.optionId)}
            >
              {opt.name}
            </Button>
          ))
        ) : (
          <LegacyButtons requestId={requestId} onRespond={onRespond} />
        )}
      </div>
    </div>
  );
}
