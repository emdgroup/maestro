import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/ui-utils";
import { useTheme } from "@/providers/ThemeProvider";
import { Skeleton } from "@/ui/skeleton";

const THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--accent",
  "--accent-foreground",
  "--primary",
  "--primary-foreground",
  "--input",
  "--ring",
];

const IFRAME_SCRIPTS = `<script>(function(){function r(){parent.postMessage({type:'canvas-iframe-resize',height:document.documentElement.scrollHeight},'*')}window.addEventListener('load',r);new ResizeObserver(r).observe(document.documentElement);window.addEventListener('message',function(e){if(e.data&&e.data.type==='canvas-theme-update'){var el=document.getElementById('__mt__');if(el)el.textContent=e.data.css}})})()</script>`;

interface Props {
  srcdoc?: string;
  height?: number;
  title?: string;
  className?: string;
  [key: string]: unknown;
}

export function CanvasHtml({ srcdoc, height = 200, title, className }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [autoHeight, setAutoHeight] = useState(height);
  const [loaded, setLoaded] = useState(false);
  const { theme, systemTheme, accentHue, systemAccentHue } = useTheme();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (
        e.data?.type === "canvas-iframe-resize" &&
        typeof e.data.height === "number" &&
        e.source === iframeRef.current?.contentWindow
      ) {
        setAutoHeight(e.data.height);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    const cs = getComputedStyle(document.documentElement);
    const vars = THEME_VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(";");
    const isDark = theme === "dark" || (theme === "system" && systemTheme === "dark");
    const css = `:root{color-scheme:${isDark ? "dark" : "light"};${vars}}body{background:var(--background);color:var(--foreground);margin:0;padding:0;font-family:system-ui,sans-serif}`;
    iframe.contentWindow.postMessage({ type: "canvas-theme-update", css }, "*");
  }, [theme, systemTheme, accentHue, systemAccentHue]);

  const themedSrcdoc = useMemo(() => {
    if (!srcdoc) return null;
    const cs = getComputedStyle(document.documentElement);
    const vars = THEME_VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(";");
    const isDark = document.documentElement.classList.contains("dark");
    const style = `<style id="__mt__">:root{color-scheme:${isDark ? "dark" : "light"};${vars}}body{background:var(--background);color:var(--foreground);margin:0;padding:0;font-family:system-ui,sans-serif}</style>`;
    const inject = style + IFRAME_SCRIPTS;
    return srcdoc.includes("<head>")
      ? srcdoc.replace("<head>", `<head>${inject}`)
      : inject + srcdoc;
  }, [srcdoc]);

  useLayoutEffect(() => {
    setLoaded(false);
  }, [themedSrcdoc]);

  if (!themedSrcdoc) return null;
  return (
    <div className="relative w-full">
      {!loaded && (
        <Skeleton className="absolute inset-0 w-full rounded" style={{ height: autoHeight }} />
      )}
      <iframe
        ref={iframeRef}
        srcDoc={themedSrcdoc}
        sandbox="allow-scripts"
        title={title ?? "Canvas HTML"}
        onLoad={() => requestAnimationFrame(() => setLoaded(true))}
        className={cn(
          "w-full rounded bg-background transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
          className,
        )}
        style={{ height: autoHeight }}
      />
    </div>
  );
}
