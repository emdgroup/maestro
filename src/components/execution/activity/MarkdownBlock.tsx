import {
  useState,
  useEffect,
  useMemo,
  memo,
  createContext,
  useContext,
  type ReactNode,
  type CSSProperties,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkMark } from "remark-mark-highlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ZoomableContent } from "@/ui/zoomable-content";
import { commands } from "@/types/bindings";
import { sanitizeSchema } from "./markdown-sanitize";
import { InteractiveTable, InteractiveTh, InteractiveTbody } from "./MarkdownTableSort";
import { CodeBlockWrapper } from "./HighlightedCode";
import { MermaidBlock } from "./MermaidBlock";
import { SvgBlock } from "./SvgBlock";
import { SmilesBlock } from "./SmilesBlock";

export { sanitizeSvg, extractText } from "./markdown-sanitize";
export { getCompleteBlocksText, splitSvgBlocks } from "./markdown-stream-utils";
export { useCopyToClipboard, HighlightedCode, CodeBlockWrapper } from "./HighlightedCode";
export { MermaidBlock } from "./MermaidBlock";
export { SvgBlock } from "./SvgBlock";
export { SmilesBlock } from "./SmilesBlock";

function MarkdownCodeComponent({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const match = /language-([\w-]+)/.exec(className ?? "");
  const lang = match ? match[1] : "";
  const rawCode = String(children).replace(/\n$/, "");
  const isBlock = Boolean(className?.startsWith("language-")) || rawCode.includes("\n");
  if (isBlock) {
    if (lang === "markdown") return <MarkdownBlock text={rawCode} />;
    if (lang === "svg") return <SvgBlock code={rawCode} />;
    if (lang === "smiles") return <SmilesBlock code={rawCode} />;
    if (lang === "mermaid") return <MermaidBlock code={rawCode} />;
    return <CodeBlockWrapper code={rawCode} lang={lang} />;
  }
  return (
    <code
      style={{ background: "color-mix(in oklch, var(--foreground) 15%, var(--muted))" }}
      className="px-1 py-0.5 rounded text-xs font-mono"
    >
      {children}
    </code>
  );
}

function scrollToTarget(target: HTMLElement): void {
  let container: HTMLElement | null = target.parentElement;
  while (container && container !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(container);
    if (overflowY === "auto" || overflowY === "scroll") break;
    container = container.parentElement as HTMLElement | null;
  }
  const root = container ?? document.documentElement;
  const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
  root.scrollTo({ top: root.scrollTop + offset, behavior: "smooth" });
}

export const OpenFileContext = createContext<((uri: string) => void) | undefined>(undefined);

function MarkdownAnchorComponent({
  href,
  children,
  "data-open-file-uri": dataOpenFileUri,
}: {
  href?: string;
  children?: ReactNode;
  "data-open-file-uri"?: string;
}) {
  const openFile = useContext(OpenFileContext);
  return (
    <a
      href={href}
      data-open-file-uri={dataOpenFileUri}
      onClick={(e) => {
        if (dataOpenFileUri) return; // handled by ActivityUserMessage event delegation
        e.preventDefault();
        if (!href) return;
        if (href.startsWith("#")) {
          const anchor = href.slice(1);
          const clicked = e.currentTarget as HTMLElement;
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(`[id="${CSS.escape(anchor)}"]`),
          );
          if (candidates.length === 0) return;
          const target =
            candidates.find(
              (el) => clicked.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
            ) ?? candidates[candidates.length - 1];
          scrollToTarget(target);
        } else if (href.startsWith("file://") && openFile) {
          openFile(href);
        } else {
          openUrl(href);
        }
      }}
      className="text-accent underline underline-offset-2 hover:text-accent/80 cursor-pointer"
    >
      <InsideAnchorContext.Provider value={true}>{children}</InsideAnchorContext.Provider>
    </a>
  );
}

// react-markdown's defaultUrlTransform blocks data: and blob: protocols.
// We pass data: through so ProxiedImage can convert them to blob URLs.
// Security is preserved: rehypeSanitize still enforces protocols.src and protocols.href.
function markdownUrlTransform(url: string): string {
  if (url.startsWith("data:") || url.startsWith("file://")) return url;
  return defaultUrlTransform(url);
}

// MarkdownBlock body references MARKDOWN_COMPONENTS at render time (not definition time),
// so the forward reference is safe — MARKDOWN_COMPONENTS is initialized before any rendering.
type ImageProxyContextValue = { projectId: number; baseDir: string | undefined } | undefined;
export const ImageProxyContext = createContext<ImageProxyContextValue>(undefined);
const InsideAnchorContext = createContext(false);

function stripMarkdownFences(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^`{3,}(markdown|md)\s*$/.test(lines[i])) {
      let rangeEnd = lines.length;
      for (let k = i + 1; k < lines.length; k++) {
        if (/^`{3,}(markdown|md)\s*$/.test(lines[k])) {
          rangeEnd = k;
          break;
        }
      }
      let closeIdx = -1;
      for (let k = rangeEnd - 1; k > i; k--) {
        if (/^`{3,}\s*$/.test(lines[k])) {
          closeIdx = k;
          break;
        }
      }
      if (closeIdx !== -1) {
        result.push(...lines.slice(i + 1, closeIdx));
        i = closeIdx + 1;
        continue;
      }
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n");
}

export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  breaks,
  projectId,
  baseDir,
}: {
  text: string;
  breaks?: boolean;
  projectId?: number;
  baseDir?: string;
}) {
  const components = useMemo(() => {
    if (!projectId) return MARKDOWN_COMPONENTS;
    return { ...MARKDOWN_COMPONENTS, img: ProxiedImage };
  }, [projectId]);

  const ctxValue = useMemo(
    () => (projectId !== undefined ? { projectId, baseDir } : undefined),
    [projectId, baseDir],
  );

  const processedText = useMemo(() => stripMarkdownFences(text), [text]);

  const content = (
    <Markdown
      remarkPlugins={breaks ? [remarkBreaks, ...MARKDOWN_PLUGINS.remark!] : MARKDOWN_PLUGINS.remark}
      rehypePlugins={MARKDOWN_PLUGINS.rehype}
      urlTransform={markdownUrlTransform}
      // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is complex; cast is correct at runtime
      components={components as any}
    >
      {processedText}
    </Markdown>
  );

  if (!ctxValue) return content;
  return <ImageProxyContext.Provider value={ctxValue}>{content}</ImageProxyContext.Provider>;
});

const imageProxyCache = new Map<string, string>();

function ProxiedImage({
  src,
  alt,
  width,
}: {
  src?: string;
  alt?: string;
  width?: string | number;
}) {
  const ctx = useContext(ImageProxyContext);
  const insideAnchor = useContext(InsideAnchorContext);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(src);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!src) {
      setResolvedSrc(undefined);
      return;
    }
    if (src.startsWith("blob:")) {
      setResolvedSrc(src);
      return;
    }
    if (src.startsWith("data:")) {
      try {
        const comma = src.indexOf(",");
        const meta = src.slice(5, comma); // e.g. "image/svg+xml;base64"
        const isBase64 = meta.endsWith(";base64");
        const mime = isBase64 ? meta.slice(0, -7) : meta;
        const data = src.slice(comma + 1);
        const bytes = isBase64
          ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(decodeURIComponent(data));
        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        setResolvedSrc(url);
        return () => URL.revokeObjectURL(url);
      } catch {
        setResolvedSrc(src);
        return;
      }
    }
    if (!ctx) {
      setResolvedSrc(src);
      return;
    }

    const absolutePath = ctx.baseDir && _isLocalSrc(src) ? _resolveFilePath(src, ctx.baseDir) : src;
    const cacheKey = `${ctx.projectId}:${absolutePath}`;
    const cached = imageProxyCache.get(cacheKey);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }

    const isHttp = absolutePath.startsWith("http://") || absolutePath.startsWith("https://");
    if (isHttp) {
      setResolvedSrc(src);
    } else {
      setLoading(true);
    }

    commands.proxyImage(ctx.projectId, absolutePath).then((result) => {
      if (result.status === "ok") {
        imageProxyCache.set(cacheKey, result.data);
        setResolvedSrc(result.data);
      } else if (!isHttp) {
        setResolvedSrc(src);
      }
      setLoading(false);
    });
  }, [src, ctx]);

  if (loading) {
    return <span className="inline-block w-32 h-20 bg-muted rounded-md animate-pulse my-2" />;
  }

  if (insideAnchor) {
    return (
      <img
        src={resolvedSrc}
        alt={alt ?? ""}
        width={width}
        className="inline-block align-middle max-w-full rounded-md my-2"
        loading="lazy"
      />
    );
  }

  const imgEl = (
    <img
      src={resolvedSrc}
      alt={alt ?? ""}
      width={width}
      className="max-w-full rounded-md my-2"
      loading="lazy"
    />
  );

  return (
    <ZoomableContent ariaLabel={alt || "Image"} className="inline-block align-middle">
      {imgEl}
    </ZoomableContent>
  );
}

function MarkdownImgComponent({
  src,
  alt,
  width,
}: {
  src?: string;
  alt?: string;
  width?: string | number;
}) {
  const insideAnchor = useContext(InsideAnchorContext);
  if (insideAnchor) {
    return (
      <img
        src={src}
        alt={alt ?? ""}
        width={width}
        className="inline-block align-middle max-w-full rounded-md my-2"
        loading="lazy"
      />
    );
  }
  const imgEl = (
    <img
      src={src}
      alt={alt ?? ""}
      width={width}
      className="max-w-full rounded-md my-2"
      loading="lazy"
    />
  );
  return (
    <ZoomableContent ariaLabel={alt || "Image"} className="inline-block align-middle">
      {imgEl}
    </ZoomableContent>
  );
}

export const MARKDOWN_PLUGINS = {
  remark: [remarkGfm, remarkMath, remarkMark] as Parameters<typeof Markdown>[0]["remarkPlugins"],
  rehype: [rehypeKatex, rehypeRaw, rehypeSlug, [rehypeSanitize, sanitizeSchema]] as Parameters<
    typeof Markdown
  >[0]["rehypePlugins"],
};

export const MARKDOWN_COMPONENTS = {
  code: MarkdownCodeComponent,
  h1: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h1 id={id} className="text-xl font-bold mt-4 mb-2">
      {children}
    </h1>
  ),
  h2: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h2 id={id} className="text-lg font-bold mt-3 mb-1.5">
      {children}
    </h2>
  ),
  h3: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h3 id={id} className="text-base font-semibold mt-2.5 mb-1">
      {children}
    </h3>
  ),
  h4: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h4 id={id} className="text-sm font-semibold mt-2 mb-1">
      {children}
    </h4>
  ),
  h5: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h5 id={id} className="text-sm font-medium mt-1.5 mb-0.5">
      {children}
    </h5>
  ),
  h6: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <h6 id={id} className="text-xs font-medium mt-1.5 mb-0.5 text-muted-foreground">
      {children}
    </h6>
  ),
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  p: ({ children, align }: { children?: ReactNode; align?: string }) => (
    <p
      className="mb-2 last:mb-0"
      style={align ? { textAlign: align as CSSProperties["textAlign"] } : undefined}
    >
      {children}
    </p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="list-disc pl-5 mb-2">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="list-decimal pl-5 mb-2">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="mb-0.5">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  mark: ({ children }: { children?: ReactNode }) => (
    <mark className="bg-yellow-200/60 dark:bg-yellow-500/30 rounded px-0.5">{children}</mark>
  ),
  a: MarkdownAnchorComponent,
  img: MarkdownImgComponent,
  table: ({ children }: { children?: ReactNode }) => (
    <InteractiveTable>{children}</InteractiveTable>
  ),
  thead: ({ children }: { children?: ReactNode }) => (
    <thead className="bg-muted/60">{children}</thead>
  ),
  th: ({ children }: { children?: ReactNode }) => <InteractiveTh>{children}</InteractiveTh>,
  tbody: ({ children }: { children?: ReactNode }) => (
    <InteractiveTbody>{children}</InteractiveTbody>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border border-border px-2.5 py-1 text-foreground/80">{children}</td>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="border-l-2 border-muted-foreground pl-3 italic text-muted-foreground my-1.5">
      {children}
    </blockquote>
  ),
};

function _isLocalSrc(src: string) {
  return (
    !src.startsWith("http://") &&
    !src.startsWith("https://") &&
    !src.startsWith("data:") &&
    !src.startsWith("blob:")
  );
}

function _resolveFilePath(src: string, baseDir: string): string {
  try {
    const isWindows = /^[a-zA-Z]:[\\/]/.test(baseDir);
    const normalized = baseDir.replace(/\\/g, "/");
    const base = isWindows ? `file:///${normalized}/` : `file://${normalized}/`;
    const resolved = new URL(src, base).pathname;
    return isWindows ? resolved.replace(/^\/([a-zA-Z]:)/, "$1") : resolved;
  } catch {
    return `${baseDir}/${src}`;
  }
}
