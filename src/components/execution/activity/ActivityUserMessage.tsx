import { User } from "lucide-react";
import type { UserMessageItem } from "./types";
import { MarkdownBlock } from "./MarkdownBlock";
import { ZoomableContent } from "@/ui/zoomable-content";
import { Message, MessageContent } from "@/ui/message";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripContextBlocks(text: string): string {
  return text.replace(/<context(?:\s[^>]*)?>[\s\S]*?<\/context>/g, "");
}

function preprocessUserMarkdown(text: string): string {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^([2-9]\d*|[1-9]\d+)\./, "$1\\.");
}

function buildTextMarkdown(blocks: ParsedContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" || b.type === "attachment")
    .map((block) => {
      if (block.type === "text") {
        return escapeHtml(block.text).replace(/^([2-9]\d*|[1-9]\d+)\./m, "$1\\.");
      }
      if (!block.uri) {
        return `<span class="text-accent/80 font-mono text-xs">@${escapeHtml(block.name)}</span>`;
      }
      return `<a data-open-file-uri="${escapeHtml(block.uri)}" class="text-accent underline underline-offset-2 hover:text-accent/80 cursor-pointer font-mono text-xs">@${escapeHtml(block.name)}</a>`;
    })
    .join("");
}

interface ActivityUserMessageProps {
  message: UserMessageItem;
  onOpenFile?: (uri: string) => void;
}

export type ParsedContentBlock =
  | { type: "text"; text: string }
  | { type: "attachment"; name: string; uri?: string }
  | { type: "image"; data: string; mimeType: string; name: string };

export interface ParsedUserContent {
  text: string;
  attachments: string[];
  blocks: ParsedContentBlock[];
}

export function parseUserContent(raw: string): ParsedUserContent {
  try {
    const parsed = Array.isArray(raw as unknown) ? (raw as unknown as unknown[]) : JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const stripped = stripContextBlocks(raw).trim();
      return { text: stripped, attachments: [], blocks: [{ type: "text", text: stripped }] };
    }
    const textParts: string[] = [];
    const attachments: string[] = [];
    const blocks: ParsedContentBlock[] = [];
    for (const block of parsed) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = stripContextBlocks(block.text);
        textParts.push(text);
        blocks.push({ type: "text", text });
      } else if (block.type === "resource" && block.resource?.uri) {
        const uri: string = block.resource.uri;
        const name = uri.split("/").pop() ?? uri;
        attachments.push(name);
        blocks.push({ type: "attachment", name, uri });
      } else if (block.type === "resource_link" && block.name) {
        attachments.push(block.name);
        blocks.push({ type: "attachment", name: block.name, uri: block.uri as string | undefined });
      } else if (block.type === "image" && typeof block.data === "string") {
        const name = (block.uri as string | undefined)?.split("/").pop() ?? "image";
        blocks.push({
          type: "image",
          data: block.data,
          mimeType: (block.mimeType as string) ?? "image/png",
          name,
        });
      }
    }
    return { text: textParts.join(""), attachments, blocks };
  } catch {
    const stripped = stripContextBlocks(raw).trim();
    return { text: stripped, attachments: [], blocks: [{ type: "text", text: stripped }] };
  }
}

export function ActivityUserMessage({ message, onOpenFile }: ActivityUserMessageProps) {
  const parsed = parseUserContent(message.content);
  const hasAttachments = parsed.blocks.some((b) => b.type === "attachment");
  const imageBlocks = parsed.blocks.filter(
    (b): b is Extract<ParsedContentBlock, { type: "image" }> => b.type === "image",
  );
  const hasExtras = imageBlocks.length > 0;

  function handleClick(e: React.MouseEvent) {
    const a = (e.target as Element).closest("a[data-open-file-uri]");
    const uri = a?.getAttribute("data-open-file-uri");
    if (uri && onOpenFile) {
      e.preventDefault();
      onOpenFile(uri);
    }
  }

  return (
    <Message className="gap-2.5 items-start">
      <div className="p-px rounded-full bg-gradient-to-br from-accent/60 to-accent/15 flex-shrink-0 mt-[7px]">
        <div className="w-7 h-7 rounded-full bg-card flex items-center justify-center">
          <User className="w-3.5 h-3.5 text-accent/70" />
        </div>
      </div>
      <MessageContent>
        <div className="p-px rounded-[10px] bg-gradient-to-br from-accent/60 to-accent/15">
          <div
            className="bg-card rounded-[9px] px-3.5 py-2.5 text-sm leading-relaxed text-foreground break-words"
            onClick={handleClick}
          >
            {hasAttachments ? (
              <MarkdownBlock text={buildTextMarkdown(parsed.blocks)} breaks />
            ) : (
              <MarkdownBlock text={preprocessUserMarkdown(parsed.text)} breaks />
            )}
            {hasExtras && (
              <div className="flex flex-wrap items-start gap-2 mt-2 pt-2 border-t border-border/15">
                {imageBlocks.map((b, i) => (
                  <ZoomableContent key={i} ariaLabel={b.name}>
                    <img
                      src={`data:${b.mimeType};base64,${b.data}`}
                      alt={b.name}
                      className="max-w-[240px] max-h-48 rounded-md border border-border/20 object-cover"
                    />
                  </ZoomableContent>
                ))}
              </div>
            )}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
