import { useState, useEffect, useRef, useId, useCallback, useMemo, createContext, useContext, Children, isValidElement, type ReactNode, type ReactElement } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkMark } from "remark-mark-highlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import "katex/dist/katex.min.css";
import { Bot, Copy, Check } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getDiffHighlighter } from "@/lib/shiki-highlighter";
import { useTheme } from "@/providers/ThemeProvider";
import type { MessageItem } from "./types";

const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...defaultSchema.attributes,
    // Allow class on code/pre for syntax highlighting passthrough
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    // Allow id on headings so rehype-slug IDs survive sanitization (needed for anchor links)
    h1: [...(defaultSchema.attributes?.h1 ?? []), "id"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
    h5: [...(defaultSchema.attributes?.h5 ?? []), "id"],
    h6: [...(defaultSchema.attributes?.h6 ?? []), "id"],
  },
};

const SVG_ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "path", "rect", "circle", "ellipse", "line",
  "polyline", "polygon", "text", "tspan", "lineargradient", "radialgradient",
  "stop", "clippath", "mask", "use", "symbol", "marker", "pattern",
  "filter", "fegaussianblur", "feoffset", "femerge", "femergenode",
  "animate", "animatetransform",
]);

const SVG_ALLOWED_ATTRS = new Set([
  "viewbox", "width", "height", "xmlns", "fill", "stroke", "stroke-width",
  "d", "cx", "cy", "r", "rx", "ry", "x", "x1", "x2", "y", "y1", "y2",
  "points", "transform", "opacity", "font-size", "font-family", "text-anchor",
  "style", "offset", "stop-color", "stop-opacity", "stroke-linecap",
  "stroke-linejoin", "id", "class", "gradientunits", "dx", "dy",
  "dominant-baseline", "fill-opacity", "stroke-opacity", "stroke-dasharray",
  "stroke-dashoffset",
  // SMIL animation attributes
  "attributename", "attributetype", "from", "to", "by", "values", "dur",
  "begin", "end", "repeatcount", "repeatdur", "fill", "calcmode", "keytimes",
  "keysplines", "keypoints", "additive", "accumulate", "type",
]);

function sanitizeSvg(raw: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "image/svg+xml");
  if (doc.querySelector("parsererror")) return "";

  function walkNode(node: Element) {
    const attrsToRemove: string[] = [];
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || !SVG_ALLOWED_ATTRS.has(name)) {
        attrsToRemove.push(attr.name);
      }
    }
    for (const attr of attrsToRemove) node.removeAttribute(attr);

    const toRemove: Element[] = [];
    for (const child of Array.from(node.children)) {
      if (!SVG_ALLOWED_ELEMENTS.has(child.tagName.toLowerCase())) {
        toRemove.push(child);
      } else {
        walkNode(child);
      }
    }
    for (const el of toRemove) el.remove();
  }

  const svgEl = doc.documentElement;
  if (svgEl.tagName.toLowerCase() !== "svg") return "";
  walkNode(svgEl);
  return new XMLSerializer().serializeToString(svgEl);
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

function compareValues(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

interface TableSort { col: number | null; asc: boolean; }
interface TableSortContextValue {
  sort: TableSort;
  onSort: (col: number) => void;
  getNextHeaderIndex: () => number;
}
const TableSortContext = createContext<TableSortContextValue | null>(null);

function InteractiveTable({ children }: { children: ReactNode }) {
  const [sort, setSort] = useState<TableSort>({ col: null, asc: true });
  const headerCountRef = useRef(0);
  // Reset header counter each render so th components get correct indices on mount
  headerCountRef.current = 0;
  const getNextHeaderIndex = useCallback(() => headerCountRef.current++, []);
  const onSort = useCallback((col: number) => {
    setSort((prev) => ({ col, asc: prev.col === col ? !prev.asc : true }));
  }, []);
  return (
    <TableSortContext.Provider value={{ sort, onSort, getNextHeaderIndex }}>
      <div className="overflow-x-auto my-2">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    </TableSortContext.Provider>
  );
}

function InteractiveTh({ children }: { children: ReactNode }) {
  const ctx = useContext(TableSortContext);
  const colRef = useRef(-1);
  if (ctx && colRef.current === -1) {
    colRef.current = ctx.getNextHeaderIndex();
  }
  const col = colRef.current;
  const isSorted = ctx?.sort.col === col;
  return (
    <th
      className="border border-border px-2.5 py-1.5 text-left font-semibold text-muted-foreground cursor-pointer select-none hover:bg-muted/80 transition-colors"
      onClick={() => ctx?.onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <span className="text-[8px] opacity-40">{isSorted ? (ctx.sort.asc ? "▲" : "▼") : "⇅"}</span>
      </span>
    </th>
  );
}

function InteractiveTbody({ children }: { children: ReactNode }) {
  const ctx = useContext(TableSortContext);
  if (!ctx || ctx.sort.col === null) return <tbody>{children}</tbody>;
  const { col, asc } = ctx.sort;
  const rows = Children.toArray(children);
  const sorted = [...rows].sort((a, b) => {
    const getText = (row: ReactNode) => {
      if (!isValidElement(row)) return "";
      const cells = Children.toArray((row as ReactElement<{ children?: ReactNode }>).props.children);
      return extractText(cells[col]);
    };
    const cmp = compareValues(getText(a), getText(b));
    return asc ? cmp : -cmp;
  });
  return <tbody>{sorted}</tbody>;
}

interface ActivityMessageItemProps {
  message: MessageItem;
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  useEffect(() => {
    let cancelled = false;
    getDiffHighlighter().then((hl) => {
      if (cancelled) return;
      try {
        const engine = hl.getHighlighterEngine();
        const result = engine.codeToHtml(code, {
          lang: lang || "text",
          theme: isDark ? "github-dark" : "github-light",
        });
        if (!cancelled) setHtml(result);
      } catch {
        // fallback to plain
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, isDark]);

  if (html) {
    return (
      <div
        className="text-xs overflow-x-auto [&_pre]:p-3 [&_pre]:m-0 [&_pre]:rounded-none"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki-generated trusted HTML
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <pre className="bg-muted p-3 overflow-x-auto text-xs">
      <code>{code}</code>
    </pre>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const id = useId();
  const elId = `mermaid-${id.replace(/:/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(false);
    import("mermaid").then((m) => {
      if (cancelled) return;
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: isDark ? "dark" : "default",
      });
      m.default
        .render(elId, code)
        .then(({ svg: rendered }) => {
          if (!cancelled) setSvg(rendered);
        })
        .catch(() => {
          if (!cancelled) setError(true);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [code, elId, isDark]);

  if (error) {
    return (
      <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs text-destructive">
        {code}
      </pre>
    );
  }
  if (!svg) {
    return <div className="h-24 bg-muted/50 rounded-md my-2 animate-pulse" />;
  }
  return (
    <div
      className="my-2 overflow-x-auto"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-mode SVG
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function SvgBlock({ code }: { code: string }) {
  const sanitized = useMemo(() => {
    try {
      return sanitizeSvg(code);
    } catch {
      return "";
    }
  }, [code]);

  if (!sanitized) {
    return (
      <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs text-destructive">
        {code}
      </pre>
    );
  }
  return (
    <div
      className="my-2 overflow-x-auto"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}


type Segment = { type: "text"; content: string } | { type: "svg"; content: string };

export function getCompleteBlocksText(text: string): string {
  if (!text.includes("\n\n")) return "";

  let fenceCount = 0;
  let lastSafeBoundary = -1;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      fenceCount++;
      i += 3;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (text[i] === "\n" && i + 1 < text.length && text[i + 1] === "\n") {
      if (fenceCount % 2 === 0) {
        lastSafeBoundary = i + 2;
      }
      i += 2;
      while (i < text.length && text[i] === "\n") i++;
      continue;
    }

    i++;
  }

  if (lastSafeBoundary <= 0) return "";
  return text.slice(0, lastSafeBoundary).trimEnd();
}

function splitSvgBlocks(text: string): Segment[] {
  if (!text.includes("<svg")) return [{ type: "text", content: text }];
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(/<svg[\s\S]*?<\/svg>/gi)) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "svg", content: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

function useCopyToClipboard(text: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return { copied, copy };
}

function CodeBlockWrapper({ code, lang }: { code: string; lang: string }) {
  const { copied, copy: handleCopy } = useCopyToClipboard(code);

  return (
    <div className="relative group/code my-2 rounded-md border border-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">
          {lang || "text"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="opacity-0 group-hover/code:opacity-100 transition-opacity p-0.5 rounded text-muted-foreground hover:text-foreground"
          aria-label={copied ? "Copied" : "Copy"}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      <HighlightedCode code={code} lang={lang} />
    </div>
  );
}


function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[2px] ml-1 align-middle" aria-label="typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1 h-1 rounded-full bg-foreground/50"
          style={{ animation: `typing-dot 1.2s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </span>
  );
}

const MARKDOWN_PLUGINS = {
  remark: [remarkGfm, remarkMath, remarkMark] as Parameters<typeof Markdown>[0]["remarkPlugins"],
  // rehype-slug must come before rehype-sanitize so IDs it adds are preserved
  rehype: [rehypeKatex, rehypeRaw, rehypeSlug, [rehypeSanitize, sanitizeSchema]] as Parameters<typeof Markdown>[0]["rehypePlugins"],
};

function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={MARKDOWN_PLUGINS.remark}
      rehypePlugins={MARKDOWN_PLUGINS.rehype}
      components={{
        code: ({ children, className }) => {
          const match = /language-([\w-]+)/.exec(className ?? "");
          const lang = match ? match[1] : "";
          const rawCode = String(children).replace(/\n$/, "");
          // Treat as block if it has an explicit language OR contains newlines (fenced block with no lang)
          const isBlock = Boolean(className?.startsWith("language-")) || rawCode.includes("\n");
          if (isBlock) {
            if (lang === "markdown") {
              return <MarkdownBlock text={rawCode} />;
            }
            if (lang === "svg") {
              return <SvgBlock code={rawCode} />;
            }
if (lang === "mermaid") {
              return <MermaidBlock code={rawCode} />;
            }
            return <CodeBlockWrapper code={rawCode} lang={lang} />;
          }
          return (
            <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          );
        },
        h1: ({ children, id }) => <h1 id={id} className="text-xl font-bold mt-4 mb-2">{children}</h1>,
        h2: ({ children, id }) => <h2 id={id} className="text-lg font-bold mt-3 mb-1.5">{children}</h2>,
        h3: ({ children, id }) => <h3 id={id} className="text-base font-semibold mt-2.5 mb-1">{children}</h3>,
        h4: ({ children, id }) => <h4 id={id} className="text-sm font-semibold mt-2 mb-1">{children}</h4>,
        h5: ({ children, id }) => <h5 id={id} className="text-sm font-medium mt-1.5 mb-0.5">{children}</h5>,
        h6: ({ children, id }) => <h6 id={id} className="text-xs font-medium mt-1.5 mb-0.5 text-muted-foreground">{children}</h6>,
        pre: ({ children }) => <>{children}</>,
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
        li: ({ children }) => <li className="mb-0.5">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        mark: ({ children }) => <mark className="bg-yellow-200/60 dark:bg-yellow-500/30 rounded px-0.5">{children}</mark>,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (!href) return;
              if (href.startsWith("#")) {
                document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
              } else {
                openUrl(href);
              }
            }}
            className="text-accent underline underline-offset-2 hover:text-accent/80 cursor-pointer"
          >
            {children}
          </a>
        ),
        img: ({ src, alt }) => (
          <img
            src={src}
            alt={alt ?? ""}
            className="max-w-full rounded-md my-2"
            loading="lazy"
          />
        ),
        table: ({ children }) => <InteractiveTable>{children}</InteractiveTable>,
        thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
        th: ({ children }) => <InteractiveTh>{children}</InteractiveTh>,
        tbody: ({ children }) => <InteractiveTbody>{children}</InteractiveTbody>,
        td: ({ children }) => (
          <td className="border border-border px-2.5 py-1 text-foreground/80">
            {children}
          </td>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}

export function ActivityMessageItem({ message }: ActivityMessageItemProps) {
  const lastTextRef = useRef<{ text: string; time: number }>({ text: "", time: 0 });
  const [isActivelyStreaming, setIsActivelyStreaming] = useState(false);
  const { copied: messageCopied, copy: handleCopyMessage } = useCopyToClipboard(message.text);

  useEffect(() => {
    if (message.isStreaming) {
      lastTextRef.current = { text: message.text, time: Date.now() };
    }
  }, [message.text, message.isStreaming]);

  useEffect(() => {
    if (!message.isStreaming) {
      setIsActivelyStreaming(false);
      return;
    }
    const interval = setInterval(() => {
      const stale = Date.now() - lastTextRef.current.time > 1500;
      setIsActivelyStreaming(!stale);
    }, 250);
    return () => clearInterval(interval);
  }, [message.isStreaming]);

  const completedText = useMemo(
    () => (isActivelyStreaming ? getCompleteBlocksText(message.text) : ""),
    [message.text, isActivelyStreaming],
  );

  const segments = useMemo(() => {
    const textToRender = isActivelyStreaming ? completedText : message.text;
    if (!textToRender) return [];
    return splitSvgBlocks(textToRender);
  }, [message.text, isActivelyStreaming, completedText]);
  const hasSvg = segments.some((s) => s.type === "svg");

  return (
    <div className="flex items-start gap-2.5 group">
      <div className="flex flex-col items-center flex-shrink-0 w-7 self-stretch">
        <div className="w-7 h-7 rounded-md bg-accent/20 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Bot className="w-4 h-4 text-accent-foreground/70" />
        </div>
        <div className="w-px flex-1 bg-border mt-1" />
      </div>
      <div className="flex-1 min-w-0 pb-1">
        <div className="text-sm leading-relaxed text-foreground">
          {message.isStreaming && isActivelyStreaming ? (
            <>
              {completedText ? (
                hasSvg ? (
                  segments.map((seg, i) =>
                    seg.type === "svg" ? (
                      <SvgBlock key={i} code={seg.content} />
                    ) : (
                      <MarkdownBlock key={i} text={seg.content} />
                    )
                  )
                ) : (
                  <MarkdownBlock text={completedText} />
                )
              ) : null}
              <TypingDots />
            </>
          ) : hasSvg ? (
            segments.map((seg, i) =>
              seg.type === "svg" ? (
                <SvgBlock key={i} code={seg.content} />
              ) : (
                <MarkdownBlock key={i} text={seg.content} />
              )
            )
          ) : (
            <MarkdownBlock text={message.text} />
          )}
        </div>
        {(!message.isStreaming || !isActivelyStreaming) && (
          <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={handleCopyMessage}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground"
              aria-label={messageCopied ? "Copied" : "Copy response"}
            >
              {messageCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
