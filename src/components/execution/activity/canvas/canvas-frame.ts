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
export const BRIDGE = `
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

  // Every field in scope, whether or not the user touched it. A form whose defaults are already
  // what the user wants fires no input events, so relying on those alone answers an untouched
  // form with nothing — and the agent cannot tell "accepted the defaults" from "left it blank".
  function recordAll(scope) {
    var fields = scope.querySelectorAll("input, select, textarea");
    for (var i = 0; i < fields.length; i++) recordField(fields[i]);
  }

  document.addEventListener("input", function (e) { recordField(e.target); }, true);
  document.addEventListener("change", function (e) { recordField(e.target); }, true);

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("button[id]") : null;
    if (!el) return;
    // A submit button inside a form is answered by the submit handler below, not twice here.
    if (el.form && el.type !== "button") return;
    // Scoped to the button's own form where it has one, so two forms on a surface answer
    // separately; a loose button takes the whole document, which is what a panel of controls
    // with an Apply button reads as.
    recordAll(el.form || document);
    maestro.emit(el.id, "click", el.value || undefined);
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    // Nothing can be posted anywhere from an opaque origin, so a real submit only blanks the page.
    e.preventDefault();
    if (!form.id) return;
    recordAll(form);
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

  var PIXEL_RATIO = 2;

  /**
   * Rasterise a region of this document to a PNG data URL.
   *
   * Hand-rolled rather than delegated to a screenshot library: every one of those resolves the
   * document it is rasterising by walking up to the top window, and from an opaque origin that
   * throws \`Blocked a frame with origin "null" from accessing a cross-origin frame\` before any
   * pixels are drawn. The technique underneath is the same one they use — clone the node, inline
   * its computed styles so the clone owes nothing to this document's stylesheets, wrap it in a
   * \`foreignObject\` and let the SVG image decoder lay it out.
   *
   * Known limits, inherited from that technique rather than from this implementation: a
   * cross-origin \`https:\` image inside the region taints the canvas and \`toDataURL\` throws,
   * \`::before\` / \`::after\` content is absent, and a scrolled container is drawn from its top.
   */
  async function capture(id, rect) {
    function fail() { post({ type: "canvas-capture-result", id: id, dataUrl: null }); }
    if (rect.width < 1 || rect.height < 1) { fail(); return; }
    try {
      var source = document.body;
      var box = source.getBoundingClientRect();
      var clone = source.cloneNode(true);
      inlineStyles(source, clone, box);
      inlineCanvases(source, clone);
      var faces = await webFontCss();

      var w = Math.ceil(box.width), h = Math.ceil(box.height);
      var serialised = new XMLSerializer().serializeToString(clone);
      var svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
        '<foreignObject width="100%" height="100%">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">' +
        (faces ? '<style xmlns="http://www.w3.org/1999/xhtml">' + faces + "</style>" : "") +
        serialised + "</div>" +
        "</foreignObject></svg>";

      var image = new Image();
      image.onload = function () {
        try {
          var out = document.createElement("canvas");
          out.width = Math.round(rect.width * PIXEL_RATIO);
          out.height = Math.round(rect.height * PIXEL_RATIO);
          var ctx = out.getContext("2d");
          if (!ctx) { fail(); return; }
          ctx.drawImage(
            image,
            Math.round(rect.left - box.left), Math.round(rect.top - box.top),
            Math.round(rect.width), Math.round(rect.height),
            0, 0, out.width, out.height
          );
          post({ type: "canvas-capture-result", id: id, dataUrl: out.toDataURL("image/png") });
        } catch (e) { fail(); }
      };
      image.onerror = fail;
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    } catch (e) { fail(); }
  }

  /**
   * Copy every computed property onto the clone, depth-first, so it stands alone in the SVG, and
   * carry across the two things a clone does not bring with it: what the user typed, which lives
   * in a property rather than an attribute, and where a fixed element actually sits — inside the
   * picture its containing block is the SVG root, not the frame's viewport.
   */
  function inlineStyles(source, clone, box) {
    var computed = getComputedStyle(source);
    var css = "";
    for (var i = 0; i < computed.length; i++) {
      var property = computed[i];
      css += property + ":" + computed.getPropertyValue(property) + ";";
    }
    if (computed.position === "fixed") {
      var at = source.getBoundingClientRect();
      css += "position:absolute;right:auto;bottom:auto;" +
        "left:" + (at.left - box.left) + "px;top:" + (at.top - box.top) + "px;";
    }
    clone.setAttribute("style", css);

    var tag = source.tagName;
    if (tag === "INPUT") {
      clone.setAttribute("value", source.value);
      if (source.checked) clone.setAttribute("checked", "");
    } else if (tag === "TEXTAREA") {
      clone.textContent = source.value;
    } else if (tag === "OPTION" && source.selected) {
      clone.setAttribute("selected", "");
    }

    for (var k = 0; k < source.children.length; k++) {
      if (clone.children[k]) inlineStyles(source.children[k], clone.children[k], box);
    }
  }

  /** A cloned \`<canvas>\` is an empty one — its bitmap only travels as an image. */
  function inlineCanvases(source, clone) {
    var live = source.querySelectorAll("canvas");
    var copies = clone.querySelectorAll("canvas");
    for (var i = 0; i < live.length && i < copies.length; i++) {
      var picture = document.createElement("img");
      try { picture.setAttribute("src", live[i].toDataURL()); } catch (e) { continue; }
      picture.setAttribute("style", copies[i].getAttribute("style") || "");
      copies[i].replaceWith(picture);
    }
  }

  var webFonts = null;

  /**
   * The document's web fonts as \`@font-face\` rules with the files inlined.
   *
   * An SVG loaded through \`<img>\` is an isolated document that fetches nothing, so a font behind
   * a URL is simply absent and every label is drawn in a system face — narrower or wider than the
   * one on screen, which is what makes text spill out of the box that fits it in the live frame.
   * Only Google Fonts stylesheets are followed, which is where the theme's Inter comes from, and
   * only their Latin subset: the full family is fourteen files for one alphabet's worth of use.
   * Fetched once per frame; any failure leaves the picture as it was, with a fallback face.
   */
  async function webFontCss() {
    if (webFonts !== null) return webFonts;
    webFonts = "";
    try {
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      var out = [];
      for (var i = 0; i < links.length; i++) {
        if (links[i].href.indexOf("https://fonts.googleapis.com/") !== 0) continue;
        var sheet = await (await fetch(links[i].href)).text();
        var blocks = sheet.match(/@font-face\\s*\\{[^}]*\\}/g) || [];
        for (var b = 0; b < blocks.length; b++) {
          if (blocks[b].indexOf("U+0000-00FF") < 0) continue;
          var url = blocks[b].match(/url\\((https:[^)]+\\.woff2)\\)/);
          if (!url) continue;
          var bytes = new Uint8Array(await (await fetch(url[1])).arrayBuffer());
          var binary = "";
          for (var n = 0; n < bytes.length; n++) binary += String.fromCharCode(bytes[n]);
          out.push(blocks[b].replace(url[1], "data:font/woff2;base64," + btoa(binary)));
        }
      }
      webFonts = out.join("");
    } catch (e) {
      webFonts = "";
    }
    return webFonts;
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
