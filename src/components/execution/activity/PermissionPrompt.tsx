import { useState } from "react";
import { Shield } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/lib";

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

interface PermissionPromptProps {
  requestId: string;
  payload: Record<string, unknown>;
  onRespond: (requestId: string, optionId: string | null) => void;
}

export function isAllowKind(kind: string): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

function extractOptions(payload: Record<string, unknown>): PermissionOption[] | null {
  const opts = payload.options;
  if (!Array.isArray(opts) || opts.length === 0) return null;
  return opts as PermissionOption[];
}

function extractTitle(payload: Record<string, unknown>): string {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  const title = toolCall?.title as string | undefined;
  if (title) return title;
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

function extractBodyText(payload: Record<string, unknown>): string | null {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  const content = toolCall?.content as Array<Record<string, unknown>> | undefined;
  if (!content) return null;
  const texts = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return texts.length > 0 ? texts.join("\n\n") : null;
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

export function PermissionPrompt({ requestId, payload, onRespond }: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  const title = extractTitle(payload);
  const bodyText = extractBodyText(payload);
  const options = extractOptions(payload);
  const isLong = bodyText && bodyText.length > BODY_COLLAPSE_LIMIT;

  return (
    <div className="border-t border-border bg-background px-3.5 py-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-8 h-8 rounded-md bg-accent/10 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Shield className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>

      {bodyText && (
        <div className="mb-2.5">
          <pre
            className={cn(
              "text-xs text-muted-foreground whitespace-pre-wrap font-sans",
              !expanded && isLong && "line-clamp-4",
            )}
          >
            {bodyText}
          </pre>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-accent hover:text-accent/80 mt-1 transition-colors"
            >
              {expanded ? "show less" : "show more"}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
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
