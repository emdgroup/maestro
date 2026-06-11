import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/ui-utils";

const THEME_VARS = [
  "--background", "--foreground", "--card", "--card-foreground",
  "--muted", "--muted-foreground", "--border", "--accent", "--accent-foreground",
  "--primary", "--primary-foreground", "--input",
];

const RESIZE_SCRIPT = `<script>(function(){function r(){parent.postMessage({type:'canvas-iframe-resize',height:document.documentElement.scrollHeight},'*')}window.addEventListener('load',r);new ResizeObserver(r).observe(document.documentElement)})()</script>`;

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

  const themedSrcdoc = useMemo(() => {
    if (!srcdoc) return null;
    const cs = getComputedStyle(document.documentElement);
    const vars = THEME_VARS.map((v) => `${v}:${cs.getPropertyValue(v).trim()}`).join(";");
    const isDark = document.documentElement.classList.contains("dark");
    const style = `<style>:root{color-scheme:${isDark ? "dark" : "light"};${vars}}body{background:var(--background);color:var(--foreground);margin:0;padding:0;font-family:system-ui,sans-serif}</style>`;
    const inject = style + RESIZE_SCRIPT;
    return srcdoc.includes("<head>") ? srcdoc.replace("<head>", `<head>${inject}`) : inject + srcdoc;
  }, [srcdoc]);

  if (!themedSrcdoc) return null;
  return (
    <iframe
      ref={iframeRef}
      srcDoc={themedSrcdoc}
      sandbox="allow-scripts"
      title={title ?? "Canvas HTML"}
      className={cn("w-full rounded bg-background", className)}
      style={{ height: autoHeight }}
    />
  );
}
