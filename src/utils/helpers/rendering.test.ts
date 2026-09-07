import { describe, it, expect, afterEach, vi } from "vitest";
import { detectSoftwareRendering } from "./rendering";

/** A WebGL context stub reporting `renderer`, or refusing the debug extension when it is null. */
function stubWebGL(renderer: string | null) {
  const UNMASKED_RENDERER_WEBGL = 0x9246;
  const gl = {
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" && renderer !== null
        ? { UNMASKED_RENDERER_WEBGL }
        : null,
    getParameter: (param: number) => (param === UNMASKED_RENDERER_WEBGL ? renderer : null),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (id: string) => (id === "webgl2" || id === "webgl" ? gl : null) as never,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectSoftwareRendering", () => {
  it.each([
    ["llvmpipe (LLVM 15.0.7, 128 bits)", "Mesa's software rasteriser"],
    ["Google SwiftShader", "Chrome's software fallback"],
    ["Mesa OffScreen", "headless Mesa"],
  ])("reports software for %s (%s)", (renderer) => {
    stubWebGL(renderer);
    expect(detectSoftwareRendering()).toBe(true);
  });

  it("reports accelerated for a real GPU", () => {
    stubWebGL("Mali-G610 MP4");
    expect(detectSoftwareRendering()).toBe(false);
  });

  it("treats a missing GL context as software — nothing is accelerated without one", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(detectSoftwareRendering()).toBe(true);
  });

  it("treats a context that throws as software", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("WebGL disabled");
    });
    expect(detectSoftwareRendering()).toBe(true);
  });

  /**
   * The asymmetry that matters: an unavailable extension is "unknown", and unknown must not turn
   * the animation off for everyone on a build that blocks it.
   */
  it("treats a blocked debug-renderer extension as accelerated, not software", () => {
    stubWebGL(null);
    expect(detectSoftwareRendering()).toBe(false);
  });
});
