import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/tauri-utils";
import { cn } from "@/lib/utils";
import { useTheme } from "@/providers/ThemeProvider";
import { Skeleton } from "@/ui/skeleton";
import type { CanvasSurface } from "../types";
import { CanvasEventContext, type CanvasEventKind } from "./canvas-events";
import { buildSrcdoc, THEME_VARS } from "./canvas-frame";

/** One element with an `id`, as the frame reports it. Rects are in the frame's viewport. */
export interface FrameNode {
  id: string;
  /** Nearest ancestor carrying an id, or null. */
  parentId: string | null;
  tag: string;
  className: string;
  role: string;
  ownText: boolean;
  childCount: number;
  rect: { left: number; top: number; width: number; height: number };
}

export interface CanvasFrameHandle {
  /** Start or stop the frame's node reporter. */
  setAnnotating: (active: boolean) => void;
  /** `outerHTML` of the named elements, trimmed to `limit`. */
  describe: (ids: string[], limit: number) => Promise<string>;
  /** Rasterise a region given in frame coordinates. Null when the frame could not. */
  capture: (rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) => Promise<string | null>;
  /** Where the frame sits in the host viewport, for turning frame rects into host ones. */
  origin: () => { left: number; top: number };
}

export interface CanvasError {
  message: string;
  source: string;
}

interface Props {
  surface: CanvasSurface;
  className?: string;
  /** Filled in with the frame's controls, so the annotation layer can drive it. */
  handleRef?: React.RefObject<CanvasFrameHandle | null>;
  onNodes?: (nodes: FrameNode[]) => void;
  onError?: (error: CanvasError) => void;
}

/** How many failures the strip names before it stops growing. */
const MAX_SHOWN_ERRORS = 3;

interface FetchRequest {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

/**
 * Perform a `maestro.fetch` on the frame's behalf.
 *
 * This is the *host* machine reaching an endpoint the agent named, and for an SSH, WSL or
 * container session the host's network is not the agent's — so it is refused unless the surface
 * declared the origin up front, and the header shows the user which origins those are.
 */
async function hostFetch(
  sources: string[],
  request: FetchRequest,
): Promise<Record<string, unknown>> {
  let origin: string;
  try {
    origin = new URL(request.url).origin;
  } catch {
    return { error: `maestro.fetch needs an absolute URL, got ${request.url}` };
  }
  if (!sources.includes(origin)) {
    return {
      error: `${origin} is not in this surface's declared sources — pass it to canvas_create`,
    };
  }
  try {
    const response = await api.canvasFetch(
      request.url,
      request.init?.method ?? null,
      request.init?.headers ?? null,
      request.init?.body ?? null,
    );
    return { status: response.status, headers: response.headers, body: response.body };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * A canvas surface: the agent's own HTML document in a sandboxed frame.
 *
 * The frame has an opaque origin and no `allow-same-origin`, so nothing inside it can reach the
 * app, `window.__TAURI__`, or any file on disk. Everything that crosses goes through the bridge
 * in `canvas-frame.ts` as a `postMessage`, and every message is checked against this frame's own
 * `contentWindow` before it is believed.
 */
export function CanvasHtml({ surface, className, handleRef, onNodes, onError }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [autoHeight, setAutoHeight] = useState(200);
  const [loaded, setLoaded] = useState(false);
  const [errors, setErrors] = useState<CanvasError[]>([]);
  const { theme, systemTheme, effectiveAccentHue, systemAccentHue } = useTheme();
  const sink = useContext(CanvasEventContext);

  // Replies the frame owes us, keyed by the id we sent with the request.
  const repliesRef = useRef(new Map<string, (value: never) => void>());
  const replySeq = useRef(0);
  // Held in refs so an inline callback from the caller does not re-subscribe the listener, which
  // would drop every reply in flight.
  const callbacksRef = useRef({ onNodes, onError });
  callbacksRef.current = { onNodes, onError };
  const sourcesRef = useRef(surface.sources);
  sourcesRef.current = surface.sources;

  const themeCss = useMemo(() => {
    // Not read directly: they are what changes the computed values below, so the memo has to
    // re-run on them or an accent change would never reach the frame.
    void effectiveAccentHue;
    void systemAccentHue;
    const computed = getComputedStyle(document.documentElement);
    const vars = THEME_VARS.map((name) => `${name}:${computed.getPropertyValue(name).trim()}`).join(
      ";",
    );
    const isDark = theme === "dark" || (theme === "system" && systemTheme === "dark");
    return (
      `:root{color-scheme:${isDark ? "dark" : "light"};${vars}}` +
      `body{background:var(--background);color:var(--foreground);font-family:var(--font-sans,system-ui),sans-serif}`
    );
  }, [theme, systemTheme, effectiveAccentHue, systemAccentHue]);

  const srcdoc = useMemo(
    () => buildSrcdoc(surface.html, surface.theme, themeCss),
    // Deliberately not `themeCss`: a theme change is pushed into the live frame below, because
    // rebuilding the document reloads it and loses scroll, focus and anything typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [surface.html, surface.theme],
  );

  const post = useCallback((message: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const message = e.data as Record<string, unknown> | null;
      if (!message || typeof message !== "object") return;
      switch (message.type) {
        case "canvas-iframe-resize":
          if (typeof message.height === "number") setAutoHeight(message.height);
          break;
        case "canvas-record":
          sink?.record(String(message.id), message.value);
          break;
        case "canvas-event":
          sink?.emit(String(message.id), message.kind as CanvasEventKind, message.value);
          break;
        case "canvas-error": {
          const error = { message: String(message.message), source: String(message.source) };
          setErrors((prev) => (prev.length >= 20 ? prev : [...prev, error]));
          callbacksRef.current.onError?.(error);
          break;
        }
        case "canvas-nodes":
          callbacksRef.current.onNodes?.(message.nodes as FrameNode[]);
          break;
        case "canvas-fetch": {
          const id = message.id;
          void hostFetch(sourcesRef.current, message as unknown as FetchRequest).then((reply) =>
            iframeRef.current?.contentWindow?.postMessage(
              { type: "canvas-fetch-result", id, ...reply },
              "*",
            ),
          );
          break;
        }
        case "canvas-describe-result":
        case "canvas-capture-result": {
          const resolve = repliesRef.current.get(String(message.id));
          if (!resolve) break;
          repliesRef.current.delete(String(message.id));
          resolve(
            (message.type === "canvas-describe-result" ? message.html : message.dataUrl) as never,
          );
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sink]);

  // A new document means new failures; the old strip described a page that is gone.
  useEffect(() => setErrors([]), [srcdoc]);

  useEffect(() => {
    if (!loaded) return;
    post({ type: "canvas-theme-update", css: themeCss });
  }, [loaded, themeCss, post]);

  useEffect(() => {
    if (!loaded) return;
    post({ type: "canvas-data", data: surface.data });
  }, [loaded, surface.data, post]);

  const patch = surface.patch;
  useEffect(() => {
    if (!loaded || !patch) return;
    post({ type: "canvas-patch", target: patch.target, html: patch.html });
  }, [loaded, patch, post]);

  const ask = useCallback(
    <T,>(message: Record<string, unknown>): Promise<T> => {
      const id = `r${replySeq.current++}`;
      return new Promise<T>((resolve) => {
        repliesRef.current.set(id, resolve as (value: never) => void);
        post({ ...message, id });
        // The frame always answers, unless it reloaded mid-question — then nothing would ever
        // settle this and the annotation that asked would hang.
        setTimeout(() => {
          if (repliesRef.current.delete(id)) resolve(null as T);
        }, 5000);
      });
    },
    [post],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      setAnnotating: (active: boolean) => post({ type: "canvas-annotate", active }),
      describe: (ids: string[], limit: number) =>
        ask<string>({ type: "canvas-describe", ids, limit }).then((html) => html ?? ""),
      capture: (rect) => ask<string | null>({ type: "canvas-capture", rect }),
      origin: () => {
        const box = iframeRef.current?.getBoundingClientRect();
        return { left: box?.left ?? 0, top: box?.top ?? 0 };
      },
    }),
    [post, ask],
  );

  // A new srcdoc reloads the iframe, which will fire `load` again. Adjusted during render rather
  // than from a layout effect so the skeleton is already showing on the frame that swaps the
  // document, instead of one frame later.
  const [loadedSrcdoc, setLoadedSrcdoc] = useState(srcdoc);
  if (loadedSrcdoc !== srcdoc) {
    setLoadedSrcdoc(srcdoc);
    setLoaded(false);
  }

  return (
    <div className="relative w-full">
      {!loaded && (
        <Skeleton className="absolute inset-0 w-full rounded" style={{ height: autoHeight }} />
      )}
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        // `allow-forms` does not let a form reach the network: the frame CSP sets
        // `form-action 'none'` and the bridge calls `preventDefault()`. Without it Chromium never
        // fires the `submit` event at all, which silently killed the bridge's `form[id]` wiring.
        sandbox="allow-scripts allow-forms"
        title={surface.title}
        onLoad={() => requestAnimationFrame(() => setLoaded(true))}
        className={cn(
          "w-full rounded bg-background transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
          className,
        )}
        style={{ height: autoHeight }}
      />
      {errors.length > 0 && (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
            <AlertTriangle className="w-3 h-3" />
            {errors.length} problem{errors.length !== 1 ? "s" : ""} in this canvas
          </div>
          <ul className="mt-1 space-y-0.5">
            {errors.slice(0, MAX_SHOWN_ERRORS).map((error, i) => (
              <li key={i} className="text-[11px] text-muted-foreground font-mono break-all">
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
