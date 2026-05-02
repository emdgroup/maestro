import { useState } from "react";
import { Shield } from "lucide-react";
import { Button } from "@/ui/button";
import { cn } from "@/lib";
import { MarkdownBlock } from "./MarkdownBlock";

interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

interface PermissionPromptProps {
  requestId: string;
  payload: Record<string, unknown>;
  onRespond: (requestId: string, optionId: string | null) => void;
  fullHeight?: boolean;
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
  const texts: string[] = [];
  for (const c of content) {
    // Direct text block (legacy/simplified format)
    if (c.type === "text" && typeof c.text === "string") {
      texts.push(c.text as string);
    }
    // ACP ToolCallContent::Content format: {type:"content", content:{type:"text", text:"..."}}
    if (c.type === "content") {
      const inner = c.content as Record<string, unknown> | undefined;
      if (inner?.type === "text" && typeof inner.text === "string") {
        texts.push(inner.text as string);
      }
    }
  }
  return texts.length > 0 ? texts.join("\n\n") : null;
}

export function isPlanPermission(payload: Record<string, unknown>): boolean {
  const toolCall = payload.toolCall as Record<string, unknown> | undefined;
  return toolCall?.kind === "switch_mode";
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

export function PermissionPrompt({ requestId, payload, onRespond, fullHeight }: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(false);

  const title = extractTitle(payload);
  const bodyText = extractBodyText(payload);
  const options = extractOptions(payload);
  const isPlan = isPlanPermission(payload);
  const isLong = bodyText && bodyText.length > BODY_COLLAPSE_LIMIT;

  const buttons = (
    <div className={cn("flex flex-wrap gap-2", fullHeight && "mt-2.5 shrink-0")}>
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
  );

  if (fullHeight) {
    return (
      <div className="flex-1 flex flex-col px-3.5 py-3 min-h-0">
        <div className="flex items-center gap-2.5 mb-2.5 shrink-0">
          <div className="w-8 h-8 rounded-md bg-accent/10 border border-accent/30 flex items-center justify-center flex-shrink-0">
            <Shield className="w-4 h-4 text-accent" />
          </div>
          <div className="text-sm font-semibold text-foreground">{title}</div>
        </div>

        {bodyText && (
          <div className="flex-1 overflow-y-auto custom-scrollbar rounded-md border border-border bg-muted/30 p-3 min-h-0">
            <div className="text-sm leading-relaxed text-foreground">
              <MarkdownBlock text={bodyText} />
            </div>
          </div>
        )}

        {buttons}
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-background px-3.5 py-3">
      <div className="flex items-center gap-2.5 mb-2.5">
        <div className="w-8 h-8 rounded-md bg-accent/10 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Shield className="w-4 h-4 text-accent" />
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
      </div>

      {bodyText && isPlan ? (
        <div className="mb-2.5 max-h-[60vh] overflow-y-auto custom-scrollbar rounded-md border border-border bg-muted/30 p-3">
          <div className="text-sm leading-relaxed text-foreground">
            <MarkdownBlock text={bodyText} />
          </div>
        </div>
      ) : bodyText ? (
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
      ) : null}

      {buttons}
    </div>
  );
}
