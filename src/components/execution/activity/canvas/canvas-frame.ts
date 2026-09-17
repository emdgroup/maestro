/**
 * The document Maestro wraps around an agent's canvas HTML.
 *
 * Everything the host adds lives here and is prepended to the agent's own document: a base tag
 * that makes relative URLs inert, the frame's own CSP, the theme tokens, Tailwind, and the bridge
 * that carries events, data, annotations and errors across the sandbox boundary.
 *
 * None of it is written to disk — `canvas_handlers.rs` saves the agent's document alone, so a
 * saved `.html` opens in any browser without Maestro in the middle.
 */

import tailwindRuntime from "@tailwindcss/browser?raw";

export type CanvasTheme = "maestro" | "tailwind" | "none";

/**
 * Tightens the policy the frame inherits from the app (both apply; the effective policy is the
 * intersection). `'self'` is deliberately absent, so even an absolute URL naming the app's own
 * origin is refused and a canvas cannot read anything Maestro serves.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "connect-src https: wss:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * A copy of the `@theme inline` block in `src/index.css` (the shadcn variables mapped onto
 * Tailwind utility names), so `bg-card` and `rounded-lg` mean in a canvas what they mean in the
 * app. Drift is a diff against that one file.
 */
const TAILWIND_THEME = `@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-info: var(--info);
  --color-purple: var(--purple);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --font-sans: "Inter", system-ui, sans-serif;
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}`;

/**
 * Every host variable the block above reads, derived from it so the two cannot disagree. A name
 * added there is copied into the frame without a second edit here.
 */
export const THEME_VARS = [
  ...new Set(
    (TAILWIND_THEME.match(/var\(--[a-z0-9-]+\)/g) ?? []).map((match) => match.slice(4, -1)),
  ),
];

/** Inter, from the URL `src/index.css` already uses. Offline this falls back to `system-ui`. */
const FONT_LINK =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">';

/**
 * `window.maestro`, plus the auto-wiring that makes HTML with no JavaScript of its own still
 * answer `canvas_await`.
 *
 * Written plainly rather than minified: it is the contract between the frame and the host, and
 * the bytes it costs are irrelevant next to the Tailwind runtime beside it.
 */
const BRIDGE = `
(function () {
  var host = parent;
  function post(message) { host.postMessage(message, "*"); }

  function report(message, source) {
    post({ type: "canvas-error", message: String(message).slice(0, 300), source: source });
  }

  // --- errors -------------------------------------------------------------------------------
  // The agent never sees its own surface, so every failure here has to be told rather than shown.
  window.addEventListener("error", function (e) {
    var el = e.target;
    if (el && el !== window && el.tagName) {
      report("failed to load " + (el.src || el.href || el.tagName), el.tagName.toLowerCase());
    } else {
      report(e.message, "script");
    }
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    report((e.reason && e.reason.message) || e.reason, "script");
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    report("blocked: " + e.blockedURI + " (" + e.violatedDirective + ")", "csp");
  });

  // --- size ---------------------------------------------------------------------------------
  function resize() {
    post({ type: "canvas-iframe-resize", height: document.documentElement.scrollHeight });
  }
  window.addEventListener("load", resize);
  new ResizeObserver(resize).observe(document.documentElement);

  // --- the bridge ---------------------------------------------------------------------------
  var data = {};
  var subscribers = [];
  var fetchSeq = 0;
  var fetchWaiters = {};

  var maestro = {
    data: data,
    onData: function (callback) {
      subscribers.push(callback);
      try { callback(data); } catch (e) { report(e.message, "script"); }
    },
    record: function (id, value) {
      post({ type: "canvas-record", id: String(id), value: value });
    },
    emit: function (id, kind, value) {
      post({ type: "canvas-event", id: String(id), kind: kind || "click", value: value });
    },
    fetch: function (url, init) {
      var id = "f" + fetchSeq++;
      return new Promise(function (resolve, reject) {
        fetchWaiters[id] = { resolve: resolve, reject: reject };
        post({ type: "canvas-fetch", id: id, url: String(url), init: init || {} });
      });
    },
  };
  window.maestro = maestro;

  // --- auto-wiring --------------------------------------------------------------------------
  function fieldValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number" || el.type === "range") {
      return el.value === "" ? null : Number(el.value);
    }
    return el.value;
  }

  function recordField(el) {
    if (!el || !el.tagName) return;
    var tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "select" && tag !== "textarea") return;
    // A radio group answers under its name, and only the checked one has anything to say.
    if (el.type === "radio") {
      if (el.checked && el.name) maestro.record(el.name, el.value);
      return;
    }
    var key = el.id || el.getAttribute("name");
    if (key) maestro.record(key, fieldValue(el));
  }

  document.addEventListener("input", function (e) { recordField(e.target); }, true);
  document.addEventListener("change", function (e) { recordField(e.target); }, true);

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("button[id]") : null;
    if (!el) return;
    // A submit button inside a form is answered by the submit handler below, not twice here.
    if (el.form && el.type !== "button") return;
    maestro.emit(el.id, "click", el.value || undefined);
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    // Nothing can be posted anywhere from an opaque origin, so a real submit only blanks the page.
    e.preventDefault();
    if (!form.id) return;
    var fields = form.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) recordField(fields[i]);
    maestro.emit(form.id, "submit");
  });

  // --- annotation ---------------------------------------------------------------------------
  var annotationObserver = null;
  var annotationResize = null;
  var annotationTimer = null;

  function reportNodes() {
    var nodes = [];
    var elements = document.querySelectorAll("[id]");
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.id === "__mt__" || el.id === "__mtw__") continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      var ownText = false;
      for (var n = 0; n < el.childNodes.length; n++) {
        var child = el.childNodes[n];
        if (child.nodeType === 3 && child.nodeValue.trim() !== "") { ownText = true; break; }
      }
      var parentId = null;
      for (var up = el.parentElement; up; up = up.parentElement) {
        if (up.id && up.id !== "__mt__" && up.id !== "__mtw__") { parentId = up.id; break; }
      }
      nodes.push({
        id: el.id,
        parentId: parentId,
        tag: el.tagName.toLowerCase(),
        className: typeof el.className === "string" ? el.className : "",
        role: el.getAttribute("role") || "",
        ownText: ownText,
        childCount: el.children.length,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    }
    post({ type: "canvas-nodes", nodes: nodes });
  }

  function scheduleNodes() {
    clearTimeout(annotationTimer);
    annotationTimer = setTimeout(reportNodes, 100);
  }

  function setAnnotating(active) {
    if (active) {
      if (!annotationObserver) {
        annotationObserver = new MutationObserver(scheduleNodes);
        annotationObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
        annotationResize = new ResizeObserver(scheduleNodes);
        annotationResize.observe(document.documentElement);
      }
      reportNodes();
      return;
    }
    if (annotationObserver) { annotationObserver.disconnect(); annotationObserver = null; }
    if (annotationResize) { annotationResize.disconnect(); annotationResize = null; }
  }

  function describe(ids, limit) {
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) parts.push(el.outerHTML);
    }
    var html = parts.join("\\n");
    return html.length > limit ? html.slice(0, limit) + "\\n… truncated" : html;
  }

  function loadScript(code) {
    if (window.__mtShot) return;
    var script = document.createElement("script");
    script.textContent = code;
    document.head.appendChild(script);
    window.__mtShot = true;
  }

  var PIXEL_RATIO = 2;
  function capture(id, rect) {
    var library = window.modernScreenshot;
    function fail() { post({ type: "canvas-capture-result", id: id, dataUrl: null }); }
    if (!library || rect.width < 1 || rect.height < 1) { fail(); return; }
    library
      .domToCanvas(document.body, { scale: PIXEL_RATIO, backgroundColor: null })
      .then(function (full) {
        var box = document.body.getBoundingClientRect();
        var cropped = document.createElement("canvas");
        cropped.width = Math.round(rect.width * PIXEL_RATIO);
        cropped.height = Math.round(rect.height * PIXEL_RATIO);
        var ctx = cropped.getContext("2d");
        if (!ctx) { fail(); return; }
        ctx.drawImage(
          full,
          Math.round((rect.left - box.left) * PIXEL_RATIO),
          Math.round((rect.top - box.top) * PIXEL_RATIO),
          cropped.width,
          cropped.height,
          0, 0, cropped.width, cropped.height
        );
        post({ type: "canvas-capture-result", id: id, dataUrl: cropped.toDataURL("image/png") });
      })
      .catch(fail);
  }

  // --- host messages ------------------------------------------------------------------------
  window.addEventListener("message", function (e) {
    // Any local page could reach an opaque-origin frame; only the embedder is listened to.
    if (e.source !== host) return;
    var message = e.data;
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "canvas-theme-update": {
        var style = document.getElementById("__mt__");
        if (style) style.textContent = message.css;
        break;
      }
      case "canvas-data": {
        data = message.data || {};
        maestro.data = data;
        for (var i = 0; i < subscribers.length; i++) {
          try { subscribers[i](data); } catch (err) { report(err.message, "script"); }
        }
        break;
      }
      case "canvas-patch": {
        var target = document.getElementById(message.target);
        if (target) target.outerHTML = message.html;
        else report("canvas_update target not found: " + message.target, "update");
        resize();
        break;
      }
      case "canvas-annotate":
        setAnnotating(Boolean(message.active));
        break;
      case "canvas-describe":
        post({
          type: "canvas-describe-result",
          id: message.id,
          html: describe(message.ids || [], message.limit || 2000),
        });
        break;
      case "canvas-load-script":
        loadScript(message.code);
        break;
      case "canvas-capture":
        capture(message.id, message.rect);
        break;
      case "canvas-fetch-result": {
        var waiter = fetchWaiters[message.id];
        if (!waiter) break;
        delete fetchWaiters[message.id];
        if (message.error) { waiter.reject(new Error(message.error)); break; }
        var body = message.body || "";
        waiter.resolve({
          ok: message.status >= 200 && message.status < 300,
          status: message.status,
          headers: message.headers || {},
          text: function () { return Promise.resolve(body); },
          json: function () {
            try { return Promise.resolve(JSON.parse(body)); }
            catch (err) { return Promise.reject(err); }
          },
        });
        break;
      }
    }
  });
})();
`;

/**
 * Wrap the agent's document in Maestro's head.
 *
 * `themeCss` is the host's live token values; it lands in `#__mt__`, which the running frame
 * replaces in place when the app theme changes rather than reloading.
 */
export function buildSrcdoc(html: string, theme: CanvasTheme, themeCss: string): string {
  let head = `<base href="about:blank">`;
  head += `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;
  // The frame's height is measured from the host, so its own margins must not offset it.
  head += `<style>html,body{margin:0}</style>`;
  if (theme !== "none") {
    head += `<script id="__mtw__">${tailwindRuntime}</script>`;
  }
  if (theme === "maestro") {
    head += `<style id="__mt__">${themeCss}</style>`;
    head += FONT_LINK;
    head += `<style type="text/tailwindcss">${TAILWIND_THEME}</style>`;
  }
  head += `<script>${BRIDGE}</script>`;

  return html.includes("<head>") ? html.replace("<head>", `<head>${head}`) : head + html;
}
