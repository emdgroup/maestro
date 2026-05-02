import { GitFork, CornerUpLeft, RotateCcw } from "lucide-react";
import type { UserMessageItem } from "./types";

interface ActivityUserMessageProps {
  message: UserMessageItem;
}

export interface ParsedUserContent {
  text: string;
  attachments: string[];
}

export function parseUserContent(raw: string): ParsedUserContent {
  try {
    // raw may already be a parsed array when replaying from DB (load_from_db path)
    const parsed = Array.isArray(raw as unknown) ? (raw as unknown as unknown[]) : JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { text: raw, attachments: [] };
    }
    const textParts: string[] = [];
    const attachments: string[] = [];
    for (const block of parsed) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "resource" && block.resource?.uri) {
        const uri: string = block.resource.uri;
        const name = uri.split("/").pop() ?? uri;
        attachments.push(name);
      } else if (block.type === "resource_link" && block.name) {
        attachments.push(block.name);
      }
    }
    return { text: textParts.join(""), attachments };
  } catch {
    return { text: raw, attachments: [] };
  }
}

export function ActivityUserMessage({ message }: ActivityUserMessageProps) {
  const parsed = parseUserContent(message.content);
  return (
    <div className="flex items-start gap-2.5 group">
      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        M
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
          {parsed.text}
          {parsed.attachments.length > 0 && (
            <span className="inline-flex flex-wrap gap-1 ml-1.5">
              {parsed.attachments.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded-md bg-accent/10 border border-accent/20 text-accent/80 px-1.5 py-0.5 text-xs font-mono"
                >
                  {name}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
            title="Fork session from here"
          >
            <GitFork className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
            title="Rewind discussion"
          >
            <CornerUpLeft className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="p-1 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
            title="Rewind everything"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
