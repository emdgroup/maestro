import { User, Paperclip } from "lucide-react";
import type { UserMessageItem } from "./types";
import { MarkdownBlock } from "./MarkdownBlock";
import { ZoomableContent } from "@/ui/zoomable-content";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripContextBlocks(text: string): string {
  return text.replace(/<context(?:\s[^>]*)?>[\s\S]*?<\/context>/g, "").trim();
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
      if (block.type === "text") return escapeHtml(block.text);
      return `<span class="inline-flex items-center rounded-md bg-accent/10 border border-accent/20 text-accent/80 px-1.5 py-0.5 text-xs font-mono mx-0.5 align-baseline">${escapeHtml(block.name)}</span>`;
    })
    .join("");
}

interface ActivityUserMessageProps {
  message: UserMessageItem;
}

export type ParsedContentBlock =
  | { type: "text"; text: string }
  | { type: "attachment"; name: string }
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
      const stripped = stripContextBlocks(raw);
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
        blocks.push({ type: "attachment", name });
      } else if (block.type === "resource_link" && block.name) {
        attachments.push(block.name);
        blocks.push({ type: "attachment", name: block.name });
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
    return { text: raw, attachments: [], blocks: [{ type: "text", text: raw }] };
  }
}

export function ActivityUserMessage({ message }: ActivityUserMessageProps) {
  const parsed = parseUserContent(message.content);
  const hasAttachments = parsed.blocks.some((b) => b.type === "attachment");
  const imageBlocks = parsed.blocks.filter(
    (b): b is Extract<ParsedContentBlock, { type: "image" }> => b.type === "image",
  );
  const attachmentBlocks = parsed.blocks.filter(
    (b): b is Extract<ParsedContentBlock, { type: "attachment" }> => b.type === "attachment",
  );
  const hasExtras = imageBlocks.length > 0 || attachmentBlocks.length > 0;

  return (
    <div className="flex items-start gap-2.5">
      <div className="p-px rounded-full bg-gradient-to-br from-accent/60 to-accent/15 flex-shrink-0 mt-[7px]">
        <div className="w-7 h-7 rounded-full bg-card flex items-center justify-center">
          <User className="w-3.5 h-3.5 text-accent/70" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="p-px rounded-[10px] bg-gradient-to-br from-accent/60 to-accent/15">
          <div className="bg-card rounded-[9px] px-3.5 py-2.5 text-sm leading-relaxed text-foreground break-words">
            {hasAttachments ? (
              <MarkdownBlock
                text={preprocessUserMarkdown(buildTextMarkdown(parsed.blocks))}
                breaks
              />
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
                {attachmentBlocks.map((b, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] px-2 py-1 rounded-md bg-[oklch(72%_0.12_195/0.08)] border border-[oklch(72%_0.12_195/0.15)] text-[oklch(72%_0.12_195)]"
                  >
                    <Paperclip className="w-3 h-3 shrink-0 opacity-70" />
                    {b.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
