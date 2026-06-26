import {
  useState,
  useEffect,
  useRef,
  useId,
  useCallback,
  useMemo,
  memo,
  createContext,
  useContext,
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkMark } from "remark-mark-highlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import { Copy, Check } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ZoomableContent } from "@/ui/zoomable-content";
import { commands } from "@/types/bindings";
import { getDiffHighlighter } from "@/lib/shiki-highlighter";
import { useTheme } from "@/providers/ThemeProvider";
import { toast } from "sonner";
import SmilesDrawer from "smiles-drawer";

const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "style"],
    div: [...(defaultSchema.attributes?.div ?? []), "className"],
    h1: [...(defaultSchema.attributes?.h1 ?? []), "id"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
    h5: [...(defaultSchema.attributes?.h5 ?? []), "id"],
    h6: [...(defaultSchema.attributes?.h6 ?? []), "id"],
  },
};

const SVG_ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "use",
  "symbol",
  "marker",
  "pattern",
  "filter",
  "fegaussianblur",
  "feoffset",
  "femerge",
  "femergenode",
  "animate",
  "animatetransform",
]);

const SVG_ALLOWED_ATTRS = new Set([
  "viewbox",
  "width",
  "height",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2",
  "points",
  "transform",
  "opacity",
  "font-size",
  "font-family",
  "text-anchor",
  "style",
  "offset",
  "stop-color",
  "stop-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "id",
  "class",
  "gradientunits",
  "dx",
  "dy",
  "dominant-baseline",
  "fill-opacity",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "attributename",
  "attributetype",
  "from",
  "to",
  "by",
  "values",
  "dur",
  "begin",
  "end",
  "repeatcount",
  "repeatdur",
  "fill",
  "calcmode",
  "keytimes",
  "keysplines",
  "keypoints",
  "additive",
  "accumulate",
  "type",
]);

export function sanitizeSvg(raw: string): string {
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

export function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node))
    return extractText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

function compareValues(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return a.localeCompare(b);
}

interface TableSort {
  col: number | null;
  asc: boolean;
}
interface TableSortContextValue {
  sort: TableSort;
  onSort: (col: number) => void;
  getNextHeaderIndex: () => number;
}
const TableSortContext = createContext<TableSortContextValue | null>(null);

function InteractiveTable({ children }: { children: ReactNode }) {
  const [sort, setSort] = useState<TableSort>({ col: null, asc: true });
  const headerCountRef = useRef(0);
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
      const cells = Children.toArray(
        (row as ReactElement<{ children?: ReactNode }>).props.children,
      );
      return extractText(cells[col]);
    };
    const cmp = compareValues(getText(a), getText(b));
    return asc ? cmp : -cmp;
  });
  return <tbody>{sorted}</tbody>;
}

export const HighlightedCode = memo(function HighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
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
});

export function MermaidBlock({ code }: { code: string }) {
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
    import("mermaid")
      .then((m) => {
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
          .catch((err: unknown) => {
            if (!cancelled) {
              setError(true);
              toast.error("Mermaid diagram syntax error", {
                id: elId,
                description: err instanceof Error ? err.message : "Failed to render diagram",
              });
            }
          });
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          toast.error("Failed to load mermaid renderer");
        }
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
    <ZoomableContent
      className="my-2 overflow-x-auto"
      ariaLabel="Mermaid diagram"
      lightboxContent={
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-mode SVG
        <div
          dangerouslySetInnerHTML={{ __html: svg }}
          className="[&_svg]:max-w-none [&_svg]:h-auto"
        />
      }
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-mode SVG */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </ZoomableContent>
  );
}

export function SvgBlock({ code }: { code: string }) {
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
    <ZoomableContent
      className="my-2 overflow-x-auto"
      ariaLabel="SVG graphic"
      lightboxContent={
        // biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist
        <div
          dangerouslySetInnerHTML={{ __html: sanitized }}
          className="[&_svg]:max-w-none [&_svg]:h-auto"
        />
      }
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: user-provided SVG sanitized via DOM allowlist */}
      <div dangerouslySetInnerHTML={{ __html: sanitized }} />
    </ZoomableContent>
  );
}

export function SmilesBlock({ code }: { code: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { theme, systemTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [svgHtml, setSvgHtml] = useState("");
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    setError(null);

    SmilesDrawer.parse(
      code.trim(),
      (tree) => {
        const drawer = new SmilesDrawer.SvgDrawer({ width: 400, height: 300, padding: 20 });
        drawer.draw(tree, svgEl, resolvedTheme);
        setSvgHtml(svgEl.outerHTML);
      },
      (err) => {
        setError(String(err));
      },
    );
  }, [code, resolvedTheme]);

  if (error) {
    return (
      <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-xs text-destructive">
        Invalid SMILES: {code}
      </pre>
    );
  }

  return (
    <ZoomableContent
      className="my-2 flex justify-start"
      ariaLabel="Molecular structure"
      lightboxContent={
        svgHtml ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: SmilesDrawer-generated SVG
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            className="[&_svg]:max-w-none [&_svg]:h-auto"
          />
        ) : undefined
      }
    >
      <svg ref={svgRef} width={400} height={300} />
    </ZoomableContent>
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

export function splitSvgBlocks(text: string): Segment[] {
  if (!text.includes("<svg")) return [{ type: "text", content: text }];

  const fencedRanges: Array<[number, number]> = [];
  const fenceMatches = [...text.matchAll(/^```[^\n]*$/gm)];
  for (let i = 0; i < fenceMatches.length - 1; i += 2) {
    const start = fenceMatches[i].index!;
    const end = fenceMatches[i + 1].index! + fenceMatches[i + 1][0].length;
    fencedRanges.push([start, end]);
  }
  const isInsideFence = (idx: number) => fencedRanges.some(([s, e]) => idx >= s && idx < e);

  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(/<svg[\s\S]*?<\/svg>/gi)) {
    if (isInsideFence(match.index!)) continue;
    if (match.index! > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "svg", content: match[0] });
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

export function useCopyToClipboard(text: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return { copied, copy };
}

export const CodeBlockWrapper = memo(function CodeBlockWrapper({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
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
});

export const MARKDOWN_PLUGINS = {
  remark: [remarkGfm, remarkMath, remarkMark] as Parameters<typeof Markdown>[0]["remarkPlugins"],
  rehype: [rehypeKatex, rehypeRaw, rehypeSlug, [rehypeSanitize, sanitizeSchema]] as Parameters<
    typeof Markdown
  >[0]["rehypePlugins"],
};

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
  return <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{children}</code>;
}

function MarkdownAnchorComponent({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        if (href.startsWith("#")) {
          document
            .getElementById(href.slice(1))
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          openUrl(href);
        }
      }}
      className="text-accent underline underline-offset-2 hover:text-accent/80 cursor-pointer"
    >
      {children}
    </a>
  );
}

// MarkdownBlock body references MARKDOWN_COMPONENTS at render time (not definition time),
// so the forward reference is safe — MARKDOWN_COMPONENTS is initialized before any rendering.
const ImageProxyContext = createContext<number | undefined>(undefined);

export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  breaks,
  projectId,
}: {
  text: string;
  breaks?: boolean;
  projectId?: number;
}) {
  const components = useMemo(() => {
    if (!projectId) return MARKDOWN_COMPONENTS;
    return { ...MARKDOWN_COMPONENTS, img: ProxiedImage };
  }, [projectId]);

  const content = (
    <Markdown
      remarkPlugins={breaks ? [remarkBreaks, ...MARKDOWN_PLUGINS.remark!] : MARKDOWN_PLUGINS.remark}
      rehypePlugins={MARKDOWN_PLUGINS.rehype}
      // biome-ignore lint/suspicious/noExplicitAny: react-markdown's Components type is complex; cast is correct at runtime
      components={components as any}
    >
      {text}
    </Markdown>
  );

  if (!projectId) return content;
  return <ImageProxyContext.Provider value={projectId}>{content}</ImageProxyContext.Provider>;
});

const imageProxyCache = new Map<string, string>();

function ProxiedImage({ src, alt }: { src?: string; alt?: string }) {
  const projectId = useContext(ImageProxyContext);
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(src);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!src || !projectId || src.startsWith("data:") || src.startsWith("blob:")) {
      setResolvedSrc(src);
      return;
    }

    const cacheKey = `${projectId}:${src}`;
    const cached = imageProxyCache.get(cacheKey);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }

    setLoading(true);
    commands.proxyImage(projectId, src).then((result) => {
      if (result.status === "ok") {
        imageProxyCache.set(cacheKey, result.data);
        setResolvedSrc(result.data);
      } else {
        setResolvedSrc(src);
      }
      setLoading(false);
    });
  }, [src, projectId]);

  if (loading) {
    return <span className="inline-block w-32 h-20 bg-muted rounded-md animate-pulse my-2" />;
  }

  return (
    <ZoomableContent ariaLabel={alt || "Image"}>
      <img
        src={resolvedSrc}
        alt={alt ?? ""}
        className="max-w-full rounded-md my-2"
        loading="lazy"
      />
    </ZoomableContent>
  );
}

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
  p: ({ children }: { children?: ReactNode }) => <p className="mb-2 last:mb-0">{children}</p>,
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
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <ZoomableContent ariaLabel={alt || "Image"}>
      <img src={src} alt={alt ?? ""} className="max-w-full rounded-md my-2" loading="lazy" />
    </ZoomableContent>
  ),
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
};
