# Fix: HTML file preview JS execution in Working Files panel

## Context

HTML files viewed through the Working Files panel can't execute JavaScript. Root cause: the iframe uses `srcDoc`, which inherits the parent page's CSP (`script-src 'self'`). Inline scripts get blocked silently.

## Fix: Blob URL iframes

Blob URLs create an opaque origin with no inherited CSP — inline scripts execute freely. The `sandbox="allow-scripts"` attribute still isolates the iframe from the parent app.

Two files to change:

### 1. `src-tauri/tauri.conf.json` — Add `frame-src` directive

Add `frame-src 'self' blob:;` to CSP string (after `script-src 'self';`). Without this, the browser blocks loading blob URLs in iframes (falls back to `default-src 'self'`).

Security impact: minimal. Only allows embedding iframes from same-origin or locally-created blob URLs.

### 2. `src/components/execution/activity/WorkingFilesPanel.tsx` — Blob URL instead of srcDoc

Replace the `srcDoc` useMemo (lines 49-52) with blob URL creation + cleanup:

```tsx
const blobUrl = useMemo(() => {
  if (viewType !== "html") return null;
  const html = injectIframeScrollbarCSS(content);
  const blob = new Blob([html], { type: "text/html" });
  return URL.createObjectURL(blob);
}, [content, viewType]);

useEffect(() => {
  return () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  };
}, [blobUrl]);
```

Change iframe from `srcDoc={srcDoc}` to `src={blobUrl ?? undefined}`.

Keep `sandbox="allow-scripts"` (no `allow-same-origin` — iframe stays isolated).

No import changes needed — `useEffect` and `useMemo` already imported.

## Verification

1. Create HTML file with inline `<script>` that modifies DOM (e.g., changes background color)
2. Open in Working Files panel — JS should execute
3. Switch between files — confirm no memory leaks (blob URLs revoked)
4. Confirm iframe can't access `window.parent` or host app storage
