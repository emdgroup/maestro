import { User } from "lucide-react";
import type { UserMessageItem } from "./types";
import { MarkdownBlock } from "./MarkdownBlock";
import { ZoomableContent } from "@/ui/zoomable-content";
import { Message, MessageContent } from "@/ui/message";
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
} from "@/ui/attachment";
import { docIcon, formatFileSize } from "./compose-bar/AttachmentShelf";

function fileTypeLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const labels: Record<string, string> = {
    pdf: "PDF",
    json: "JSON",
    md: "Markdown",
    mdx: "MDX",
    ts: "TypeScript",
    tsx: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    rs: "Rust",
    py: "Python",
    go: "Go",
    rb: "Ruby",
    java: "Java",
    c: "C",
    cpp: "C++",
    cs: "C#",
    swift: "Swift",
    kt: "Kotlin",
    yaml: "YAML",
    yml: "YAML",
    toml: "TOML",
    xml: "XML",
    html: "HTML",
    css: "CSS",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
    txt: "Text",
    csv: "CSV",
    xlsx: "Excel",
    xls: "Excel",
    docx: "Word",
    doc: "Word",
    pptx: "PowerPoint",
    ppt: "PowerPoint",
    zip: "ZIP",
    tar: "TAR",
    gz: "Gzip",
  };
  return labels[ext] ?? (ext.toUpperCase() || "File");
}

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

function buildTextMarkdown(blocks: ParsedContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" || b.type === "attachment")
    .map((block) => {
      if (block.type === "text") {
        return block.text.replace(/^([2-9]\d*|[1-9]\d+)\./m, "$1\\.");
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
  | { type: "image"; data: string; mimeType: string; name: string }
  | { type: "file"; name: string; uri?: string; mimeType?: string; size?: number };

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
    let seenText = false;
    for (const block of parsed) {
      if (block.type === "text" && typeof block.text === "string") {
        seenText = true;
        const text = stripContextBlocks(block.text);
        textParts.push(text);
        blocks.push({ type: "text", text });
      } else if (block.type === "image" && typeof block.data === "string") {
        const name = (block.uri as string | undefined)?.split(/[/\\]/).pop() ?? "image";
        blocks.push({
          type: "image",
          data: block.data,
          mimeType: (block.mimeType as string) ?? "image/png",
          name,
        });
      } else if (!seenText && block.type === "resource" && block.resource?.uri) {
        const uri: string = block.resource.uri;
        const name = uri.split(/[/\\]/).pop() ?? uri;
        blocks.push({
          type: "file",
          name,
          uri,
          mimeType: block.resource.mimeType as string | undefined,
        });
      } else if (!seenText && block.type === "resource_link" && block.name) {
        blocks.push({
          type: "file",
          name: block.name as string,
          uri: block.uri as string | undefined,
          mimeType: block.mimeType as string | undefined,
          size: block.size as number | undefined,
        });
      } else if (seenText && block.type === "resource" && block.resource?.uri) {
        const uri: string = block.resource.uri;
        const name = uri.split(/[/\\]/).pop() ?? uri;
        attachments.push(name);
        blocks.push({ type: "attachment", name, uri });
      } else if (seenText && block.type === "resource_link" && block.name) {
        attachments.push(block.name);
        blocks.push({ type: "attachment", name: block.name, uri: block.uri as string | undefined });
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
  const fileBlocks = parsed.blocks.filter(
    (b): b is Extract<ParsedContentBlock, { type: "file" }> => b.type === "file",
  );
  const hasCards = imageBlocks.length > 0 || fileBlocks.length > 0;

  function handleClick(e: React.MouseEvent) {
    const a = (e.target as Element).closest("a[data-open-file-uri]");
    const uri = a?.getAttribute("data-open-file-uri");
    if (uri && onOpenFile) {
      e.preventDefault();
      onOpenFile(uri);
    }
  }

  return (
    <Message align="end" className="gap-2.5 items-start">
      <div className="p-px rounded-full bg-gradient-to-br from-accent/60 to-accent/15 flex-shrink-0 mt-[7px]">
        <div className="w-7 h-7 rounded-full bg-card flex items-center justify-center">
          <User className="w-3.5 h-3.5 text-accent/70" />
        </div>
      </div>
      <MessageContent className="w-fit max-w-[90%]">
        <div className="p-px rounded-[10px] bg-gradient-to-br from-accent/60 to-accent/15">
          <div
            className="bg-card rounded-[9px] px-3.5 py-2.5 text-sm leading-relaxed text-foreground break-words"
            onClick={handleClick}
          >
            {hasAttachments ? (
              <MarkdownBlock text={buildTextMarkdown(parsed.blocks)} breaks />
            ) : (
              <MarkdownBlock text={parsed.text} breaks />
            )}
            {hasCards && (
              <div className="flex flex-col gap-1.5 mt-2.5">
                {imageBlocks.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {imageBlocks.map((b, i) => {
                      const src = `data:${b.mimeType};base64,${b.data}`;
                      return (
                        <ZoomableContent
                          key={i}
                          ariaLabel={b.name}
                          lightboxContent={<img src={src} alt={b.name} />}
                        >
                          <Attachment orientation="vertical" className="bg-muted">
                            <AttachmentMedia variant="image">
                              <img
                                src={src}
                                alt={b.name}
                                className="aspect-square w-full object-cover"
                              />
                            </AttachmentMedia>
                            <AttachmentContent>
                              <AttachmentTitle title={b.name}>{b.name}</AttachmentTitle>
                              <AttachmentDescription>
                                {b.mimeType.split("/").pop()?.toUpperCase()} ·{" "}
                                {formatFileSize(Math.round(b.data.length * 0.75))}
                              </AttachmentDescription>
                            </AttachmentContent>
                          </Attachment>
                        </ZoomableContent>
                      );
                    })}
                  </div>
                )}
                {fileBlocks.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {fileBlocks.map((b, i) => {
                      const Icon = docIcon(b.name);
                      const type = fileTypeLabel(b.name);
                      const meta =
                        b.size !== undefined ? `${type} · ${formatFileSize(b.size)}` : type;
                      return (
                        <Attachment
                          key={i}
                          size="sm"
                          className="max-w-60 cursor-pointer bg-muted"
                          onClick={() => b.uri && onOpenFile?.(b.uri)}
                        >
                          <AttachmentMedia className="bg-card">
                            <Icon />
                          </AttachmentMedia>
                          <AttachmentContent>
                            <AttachmentTitle>{b.name}</AttachmentTitle>
                            {meta && <AttachmentDescription>{meta}</AttachmentDescription>}
                          </AttachmentContent>
                        </Attachment>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}
