import type { UserMessageItem } from "./types";
import { MarkdownBlock } from "./MarkdownBlock";

interface ActivityUserMessageProps {
  message: UserMessageItem;
}

export type ParsedContentBlock =
  | { type: "text"; text: string }
  | { type: "attachment"; name: string };

export interface ParsedUserContent {
  text: string;
  attachments: string[];
  blocks: ParsedContentBlock[];
}

export function parseUserContent(raw: string): ParsedUserContent {
  try {
    const parsed = Array.isArray(raw as unknown) ? (raw as unknown as unknown[]) : JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { text: raw, attachments: [], blocks: [{ type: "text", text: raw }] };
    }
    const textParts: string[] = [];
    const attachments: string[] = [];
    const blocks: ParsedContentBlock[] = [];
    for (const block of parsed) {
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "resource" && block.resource?.uri) {
        const uri: string = block.resource.uri;
        const name = uri.split("/").pop() ?? uri;
        attachments.push(name);
        blocks.push({ type: "attachment", name });
      } else if (block.type === "resource_link" && block.name) {
        attachments.push(block.name);
        blocks.push({ type: "attachment", name: block.name });
      }
    }
    return { text: textParts.join(""), attachments, blocks };
  } catch {
    return { text: raw, attachments: [], blocks: [{ type: "text", text: raw }] };
  }
}

export function ActivityUserMessage({ message }: ActivityUserMessageProps) {
  const parsed = parseUserContent(message.content);
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        M
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-lg px-3.5 py-2.5 text-sm leading-relaxed text-foreground break-words">
          {parsed.blocks.map((block, i) =>
            block.type === "text" ? (
              <MarkdownBlock key={i} text={block.text} />
            ) : (
              <span
                key={i}
                className="inline-flex items-center rounded-md bg-accent/10 border border-accent/20 text-accent/80 px-1.5 py-0.5 text-xs font-mono mx-0.5 align-baseline"
              >
                {block.name}
              </span>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
