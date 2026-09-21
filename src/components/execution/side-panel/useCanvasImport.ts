/**
 * Bringing a `.html` file back in as a canvas surface.
 *
 * Two kinds of file arrive here. One Maestro wrote itself — it carries the marker block
 * `surfaceFromHtml` reads, so the surface it describes can be put straight back on screen. The
 * other is any other HTML document, which has no element ids worth waiting on and no declared
 * sources; the agent is offered the job of turning it into one.
 *
 * Either way the file is copied into the session's own workspace, because the agent cannot read a
 * path on the user's machine when the session runs over SSH, WSL or in a container — and reading
 * the document is the only way it can learn the ids a surface it did not draw uses.
 */

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { surfaceFromHtml, surfaceToHtml } from "@/components/execution/activity/canvas/canvas-file";
import {
  buildCanvasConvertPrompt,
  buildCanvasImportedPrompt,
} from "@/components/execution/activity/canvas/canvas-prompt";
import { readImportedCanvasFile, saveCanvasImport } from "@/services/canvas.service";
import type { CanvasSurface } from "@/components/execution/activity/types";

/** What the dialog is asking, with nothing in it the dialog does not display. */
export type CanvasImportRequest =
  | { kind: "trust"; surfaceId: string; sources: string[]; fileName: string }
  | { kind: "collision"; surfaceId: string; fileName: string }
  | { kind: "convert"; fileName: string };

export type CanvasImportChoice =
  | "accept"
  | "replace"
  | "keepBoth"
  | "convert"
  | "viewOnly"
  | "cancel";

type Staged =
  | { kind: "trust" | "collision"; surface: CanvasSurface; fileName: string }
  | { kind: "convert"; html: string; fileName: string };

/** A name that survives the backend's path check, which refuses separators and `..`. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.\.+/g, ".");
  return cleaned.length > 0 ? cleaned : "import.html";
}

function uniqueSurfaceId(base: string, taken: Map<string, CanvasSurface>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function useCanvasImport({
  sessionId,
  canvasMap,
  onSurface,
  onCloseSurface,
  onPrompt,
}: {
  sessionId: string;
  canvasMap: Map<string, CanvasSurface>;
  /** Puts the surface in the carousel. */
  onSurface: (surface: CanvasSurface) => void;
  /** Drops the surface an import is replacing, before the replacement lands. */
  onCloseSurface: (surfaceId: string) => void;
  /** Sends the agent a `<canvas-event>` prompt, queueing it if a turn is in flight. */
  onPrompt: (text: string) => void;
}): {
  importFile: (path: string) => void;
  request: CanvasImportRequest | null;
  resolve: (choice: CanvasImportChoice) => void;
} {
  const [staged, setStaged] = useState<Staged | null>(null);

  const importFile = useCallback((path: string) => {
    void readImportedCanvasFile(path)
      .then((text) => {
        const fileName = safeFileName(path.split(/[/\\]/).pop() ?? "import.html");
        const surface = surfaceFromHtml(text);
        setStaged(
          surface
            ? { kind: "trust", surface, fileName }
            : { kind: "convert", html: text, fileName },
        );
      })
      .catch(() => toast.error(`Could not read ${path}`));
  }, []);

  // Live the moment it is dispatched; the copy the agent reads follows. A failed copy is worth
  // saying out loud because the surface then works for the user and not for the agent.
  const accept = useCallback(
    (surface: CanvasSurface, fileName: string) => {
      onSurface(surface);
      void saveCanvasImport(sessionId, fileName, surfaceToHtml(surface))
        .then((path) => onPrompt(buildCanvasImportedPrompt(surface.surfaceId, path)))
        .catch(() => toast.error("Imported, but the agent was not given a copy it can read"));
    },
    [sessionId, onSurface, onPrompt],
  );

  const resolve = useCallback(
    (choice: CanvasImportChoice) => {
      if (!staged || choice === "cancel") {
        setStaged(null);
        return;
      }
      if (staged.kind === "trust" && choice === "accept") {
        if (canvasMap.has(staged.surface.surfaceId)) {
          setStaged({ ...staged, kind: "collision" });
          return;
        }
        accept(staged.surface, staged.fileName);
      } else if (staged.kind === "collision" && choice === "replace") {
        onCloseSurface(staged.surface.surfaceId);
        accept(staged.surface, staged.fileName);
      } else if (staged.kind === "collision" && choice === "keepBoth") {
        const surfaceId = uniqueSurfaceId(staged.surface.surfaceId, canvasMap);
        accept({ ...staged.surface, surfaceId }, staged.fileName);
      } else if (staged.kind === "convert" && choice === "convert") {
        // No placeholder surface meanwhile: the agent's own `canvas_create` is what creates it,
        // and a placeholder would leave two.
        void saveCanvasImport(sessionId, staged.fileName, staged.html)
          .then((path) => onPrompt(buildCanvasConvertPrompt(path)))
          .catch(() => toast.error("Could not put the file where the agent can read it"));
      } else if (staged.kind === "convert" && choice === "viewOnly") {
        const base = staged.fileName.replace(/\.html?$/i, "");
        const document = new DOMParser().parseFromString(staged.html, "text/html");
        // Saved through `surfaceToHtml` by the session's autosave, which makes it a real canvas
        // file — so a view-only import comes back with the session rather than being a one-off.
        onSurface({
          surfaceId: uniqueSurfaceId(base, canvasMap),
          title: document.querySelector("title")?.textContent || staged.fileName,
          html: staged.html,
          // The document brought its own styling; Maestro's tokens and Tailwind build would fight
          // with it, and there is no agent-authored markup here expecting them.
          theme: "none",
          sources: [],
          data: {},
          createdAt: Date.now(),
        });
      }
      setStaged(null);
    },
    [staged, canvasMap, accept, onSurface, onCloseSurface, onPrompt, sessionId],
  );

  const request: CanvasImportRequest | null =
    staged === null
      ? null
      : staged.kind === "convert"
        ? { kind: "convert", fileName: staged.fileName }
        : staged.kind === "collision"
          ? { kind: "collision", surfaceId: staged.surface.surfaceId, fileName: staged.fileName }
          : {
              kind: "trust",
              surfaceId: staged.surface.surfaceId,
              sources: staged.surface.sources,
              fileName: staged.fileName,
            };

  return { importFile, request, resolve };
}
