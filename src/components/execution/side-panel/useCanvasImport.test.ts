import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { useCanvasImport } from "./useCanvasImport";
import { surfaceToHtml } from "@/components/execution/activity/canvas/canvas-file";
import type { CanvasSurface } from "@/components/execution/activity/types";

const readImportedCanvasFile = vi.fn<(path: string) => Promise<string>>();
const saveCanvasImport =
  vi.fn<(sessionId: string, name: string, html: string) => Promise<string>>();

vi.mock("@/services/canvas.service", () => ({
  readImportedCanvasFile: (path: string) => readImportedCanvasFile(path),
  saveCanvasImport: (sessionId: string, name: string, html: string) =>
    saveCanvasImport(sessionId, name, html),
}));

const SURFACE: CanvasSurface = {
  surfaceId: "dash",
  title: "Deploy dashboard",
  html: "<h1 id='title'>Deploys</h1>",
  theme: "tailwind",
  sources: ["https://api.example.com"],
  data: { "/rows": [1, 2, 3] },
  createdAt: 1730000000000,
};

function setup(canvasMap = new Map<string, CanvasSurface>()) {
  const onSurface = vi.fn();
  const onCloseSurface = vi.fn();
  const onPrompt = vi.fn();
  const view = renderHook(() =>
    useCanvasImport({ sessionId: "7", canvasMap, onSurface, onCloseSurface, onPrompt }),
  );
  return { view, onSurface, onCloseSurface, onPrompt };
}

/** Drive the file read and settle the dialog's own promise chain. */
async function importFile(
  view: ReturnType<typeof setup>["view"],
  path = "C:/Users/u/Downloads/dash.html",
) {
  await act(async () => {
    view.result.current.importFile(path);
  });
}

beforeEach(() => {
  readImportedCanvasFile.mockReset();
  saveCanvasImport.mockReset();
  saveCanvasImport.mockResolvedValue("/srv/wt/.maestro/imports/dash.html");
});

describe("useCanvasImport", () => {
  it("brings a surface back with everything the file recorded", async () => {
    readImportedCanvasFile.mockResolvedValue(surfaceToHtml(SURFACE));
    const { view, onSurface, onPrompt } = setup();

    await importFile(view);
    expect(view.result.current.request).toEqual({
      kind: "trust",
      surfaceId: "dash",
      sources: ["https://api.example.com"],
      fileName: "dash.html",
    });

    await act(async () => view.result.current.resolve("accept"));

    // `data`, `sources`, `theme` and `createdAt` are the parts a rebuilt surface loses if the
    // round trip drops them — the document alone would still render.
    expect(onSurface).toHaveBeenCalledWith(SURFACE);
    expect(onPrompt).toHaveBeenCalledWith(
      expect.stringContaining("/srv/wt/.maestro/imports/dash.html"),
    );
  });

  it("replaces the surface it collides with, or keeps both under different ids", async () => {
    readImportedCanvasFile.mockResolvedValue(surfaceToHtml(SURFACE));
    const taken = new Map<string, CanvasSurface>([["dash", SURFACE]]);

    const replace = setup(taken);
    await importFile(replace.view);
    await act(async () => replace.view.result.current.resolve("accept"));
    expect(replace.view.result.current.request).toMatchObject({ kind: "collision" });
    await act(async () => replace.view.result.current.resolve("replace"));
    expect(replace.onCloseSurface).toHaveBeenCalledWith("dash");
    expect(replace.onSurface).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "dash" }));

    const keep = setup(taken);
    await importFile(keep.view);
    await act(async () => keep.view.result.current.resolve("accept"));
    await act(async () => keep.view.result.current.resolve("keepBoth"));
    expect(keep.onCloseSurface).not.toHaveBeenCalled();
    expect(keep.onSurface).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "dash-2" }));
  });

  it("offers a file Maestro did not write to the agent instead of rendering it blind", async () => {
    readImportedCanvasFile.mockResolvedValue("<html><title>Report</title><body>hi</body></html>");
    saveCanvasImport.mockResolvedValue("/srv/wt/.maestro/imports/report.html");
    const { view, onSurface, onPrompt } = setup();

    await importFile(view, "/home/u/report.html");
    expect(view.result.current.request).toEqual({ kind: "convert", fileName: "report.html" });

    await act(async () => view.result.current.resolve("convert"));
    // No placeholder surface: the agent's own `canvas_create` is what creates it.
    expect(onSurface).not.toHaveBeenCalled();
    expect(onPrompt).toHaveBeenCalledWith(expect.stringContaining("canvas_create"));
  });

  it("shows a plain file as-is when the agent is not wanted", async () => {
    readImportedCanvasFile.mockResolvedValue("<html><title>Report</title><body>hi</body></html>");
    const { view, onSurface, onPrompt } = setup();

    await importFile(view, "/home/u/report.html");
    await act(async () => view.result.current.resolve("viewOnly"));

    expect(onSurface).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceId: "report", title: "Report", theme: "none", sources: [] }),
    );
    expect(onPrompt).not.toHaveBeenCalled();
  });
});
