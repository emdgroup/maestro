/**
 * Whether this machine composites in software, and whether the user has asked for less motion —
 * the two reasons Maestro turns its decorative animation off by default.
 *
 * Asked here rather than in Rust because the answer is a property of the webview, not of the host:
 * the same board renders differently depending on whether WebKitGTK found a usable GL context.
 *
 * This is a heuristic and it is allowed to be wrong. WebKitGTK can report a real GPU for WebGL
 * while still compositing in software, so it produces false negatives. It only picks the default
 * for a switch the user can always override — never treat it as a fact about the machine.
 */

/** Renderer names that mean "no GPU". Matched as lowercased substrings. */
const SOFTWARE_RENDERERS = [
  "llvmpipe",
  "swiftshader",
  "softpipe",
  "software rasterizer",
  "mesa offscreen",
  "microsoft basic render",
];

let cached: boolean | null = null;

/**
 * Exported for tests, which need to run this against a stubbed canvas — going through the
 * memoised `isSoftwareRendering` would freeze whatever the first test happened to observe.
 */
export function detectSoftwareRendering(): boolean {
  let gl: WebGLRenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
  } catch {
    gl = null;
  }

  // No GL context at all: nothing here is accelerated. The strongest signal available, and the
  // one an SBC with no usable driver actually hits.
  if (!gl) return true;

  // Blocked by a privacy setting, or not implemented. Unknown must resolve to "accelerated": a
  // wrong `true` would cost every user on such a build their animation, with no clue why.
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (!info) return false;

  const renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "").toLowerCase();
  return SOFTWARE_RENDERERS.some((name) => renderer.includes(name));
}

/**
 * Memoised: creating a WebGL context is not free, and the renderer cannot change without a
 * restart.
 */
export function isSoftwareRendering(): boolean {
  cached ??= detectSoftwareRendering();
  return cached;
}

/**
 * Read live rather than memoised — unlike the renderer, this one can be changed in the OS while
 * Maestro is running. It still only takes effect where it is read, and the resolved default is
 * read when settings load, so a mid-session change lands at the next launch.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** What the Reduce motion switch shows before the user has ever touched it. */
export function reduceMotionDefault(): boolean {
  return prefersReducedMotion() || isSoftwareRendering();
}
