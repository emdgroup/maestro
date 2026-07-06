import { useState } from "react";
import { Shield, Pencil, Terminal, Eye, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/lib/utils.ts";
import { PlanPermissionOverlay } from "./PlanPermissionOverlay";
import {
  isAllowKind,
  extractOptions,
  extractTitle,
  extractBodyText,
  isPlanPermission,
  isPlanToolCallItem,
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

const BODY_COLLAPSE_LIMIT = 300;

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

function getToolIcon(payload: Record<string, unknown>): React.ElementType {
  const tool = payload.tool as string | undefined;
  if (tool && TOOL_ICON_MAP[tool]) return TOOL_ICON_MAP[tool];
  return Shield;
}

export function PermissionPrompt({
  requestId,
  payload,
  onRespond,
  fullHeight,
}: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  const title = extractTitle(payload);
  const bodyText = extractBodyText(payload);
  const options = extractOptions(payload);
  const isLong = bodyText && bodyText.length > BODY_COLLAPSE_LIMIT;

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

  const ToolIcon = getToolIcon(payload);

  return (
    <div className="rounded-[10px] border border-accent/30 bg-gradient-to-br from-accent/10 to-transparent p-3.5 flex flex-col gap-2.5 shadow-[0_2px_8px_oklch(0%_0_0/0.08)]">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-[7px] bg-accent/10 border border-accent/30 flex items-center justify-center shrink-0">
          <ToolIcon className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>

      {bodyText && (
        <div>
          <div
            className={cn(
              "px-2.5 py-2 bg-background/60 rounded-md border border-border/50 text-xs text-muted-foreground font-mono",
              !expanded && isLong ? "truncate" : "whitespace-pre-wrap break-words",
            )}
          >
            {bodyText}
          </div>
          {isLong && (
            <Button
              variant="ghost"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-accent hover:text-accent/80 mt-1 h-auto p-0"
            >
              {expanded ? "show less" : "show more"}
            </Button>
          )}
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
