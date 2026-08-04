import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAnnotationBlocks, describeCanvasSubtree } from "./build-annotation-prompt";
import type { Annotation } from "@/store/annotationStore";
import type { CanvasSurface } from "@/components/execution/activity/types";

const prepareExternalAttachments = vi.fn();

vi.mock("@/lib/tauri-utils", () => ({
  api: {
    prepareExternalAttachments: (...args: unknown[]) => prepareExternalAttachments(...args),
  },
}));

function diff(id: string, filePath: string, lineNumber: number, text: string): Annotation {
  return { id, kind: "diff", filePath, lineNumber, side: "new", text };
}

function canvas(over: Partial<Extract<Annotation, { kind: "canvas" }>> = {}): Annotation {
  return {
    id: "c1",
    kind: "canvas",
    surfaceId: "s-3",
    surfaceTitle: "Latency review",
    componentIds: ["lat-chart"],
    text: "the p99 axis is truncated",
    ...over,
  };
}

const surface: CanvasSurface = {
  surfaceId: "s-3",
  catalogId: "maestro-canvas/v1",
  title: "Latency review",
  components: [
    { id: "card", component: "Card", title: "Latency", children: ["lat-chart", "caption"] },
    { id: "lat-chart", component: "Chart", type: "bar", data: "/rows" },
    { id: "caption", component: "Text", text: "p99 by endpoint" },
    { id: "elsewhere", component: "Text", text: "not selected" },
  ],
  data: { "/rows": [] },
};

beforeEach(() => {
  prepareExternalAttachments.mockReset();
});

describe("buildAnnotationBlocks", () => {
  it("returns nothing for an empty list", async () => {
    expect(await buildAnnotationBlocks([])).toEqual([]);
  });

  it("groups diff annotations by file with line numbers", async () => {
    const blocks = await buildAnnotationBlocks([
      diff("1", "src/git/merge.rs", 42, "handle leaks"),
      diff("2", "src/git/merge.rs", 7, "why unwrap"),
      diff("3", "src/lib.rs", 0, "file-level note"),
    ]);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("## `src/git/merge.rs`");
    expect(text).toContain("- line:42 — handle leaks");
    expect(text).toContain("- line:7 — why unwrap");
    expect(text).toContain("## `src/lib.rs`");
    // File-level annotations carry no line prefix.
    expect(text).toContain("- file-level note");
    expect(text.match(/## `src\/git\/merge\.rs`/g)).toHaveLength(1);
  });

  it("renders plan annotations as a quote plus the note", async () => {
    const blocks = await buildAnnotationBlocks([
      {
        id: "p1",
        kind: "plan",
        quote: "never overwrites\nan existing value",
        occurrence: 0,
        text: "null or missing?",
      },
    ]);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain("## Plan");
    expect(text).toContain("> never overwrites an existing value");
    expect(text).toContain("null or missing?");
  });

  it("names the surface and the component ids for a canvas annotation", async () => {
    const blocks = await buildAnnotationBlocks([
      canvas({ componentIds: ["lat-chart", "caption"], subtree: '[{"id":"lat-chart"}]' }),
    ]);
    const text = (blocks[1] as { text: string }).text;
    expect(text).toContain("## Canvas “Latency review” (surface `s-3`)");
    expect(text).toContain("`lat-chart`, `caption`");
    expect(text).toContain('[{"id":"lat-chart"}]');
    expect(text).toContain("the p99 axis is truncated");
  });

  it("says a note with no components is about the whole surface", async () => {
    const blocks = await buildAnnotationBlocks([canvas({ componentIds: [] })]);
    expect((blocks[1] as { text: string }).text).toContain("About the surface as a whole");
  });

  it("puts the capture immediately after its own note", async () => {
    prepareExternalAttachments.mockResolvedValue([
      { content_block: { type: "image", data: "abc", mimeType: "image/png" } },
    ]);
    const blocks = await buildAnnotationBlocks(
      [canvas({ id: "a", shotPath: "/tmp/a.png" }), canvas({ id: "b", text: "second" })],
      { logId: 7, canSendImages: true },
    );
    // header, note a, image a, note b — the image must not drift to the end.
    expect(blocks).toHaveLength(4);
    expect((blocks[2] as { type: string }).type).toBe("image");
    expect((blocks[3] as { text: string }).text).toContain("second");
  });

  it("leaves the capture out when the agent takes no images", async () => {
    const blocks = await buildAnnotationBlocks([canvas({ shotPath: "/tmp/a.png" })], {
      logId: 7,
      canSendImages: false,
    });
    expect(blocks).toHaveLength(2);
    expect(prepareExternalAttachments).not.toHaveBeenCalled();
  });

  it("keeps the note when the capture cannot be attached", async () => {
    prepareExternalAttachments.mockRejectedValue(new Error("gone"));
    const blocks = await buildAnnotationBlocks([canvas({ shotPath: "/tmp/a.png" })], {
      logId: 7,
      canSendImages: true,
    });
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as { text: string }).text).toContain("the p99 axis is truncated");
  });
});

describe("describeCanvasSubtree", () => {
  it("includes the selected components and their descendants, and nothing else", () => {
    const json = describeCanvasSubtree(surface, ["card"]);
    expect(json).toContain('"id": "card"');
    expect(json).toContain('"id": "lat-chart"');
    expect(json).toContain('"id": "caption"');
    expect(json).not.toContain("elsewhere");
  });

  it("keeps data bindings as the pointers the agent authored", () => {
    expect(describeCanvasSubtree(surface, ["lat-chart"])).toContain('"data": "/rows"');
  });

  it("shortens inlined data but never the children list", () => {
    const bloated: CanvasSurface = {
      ...surface,
      components: [
        {
          id: "t",
          component: "DataTable",
          rows: Array.from({ length: 30 }, (_, i) => [i]),
          children: ["a", "b", "c", "d", "e", "f", "g"],
        },
      ],
    };
    const json = describeCanvasSubtree(bloated, ["t"]) ?? "";
    expect(json).toContain("… 25 more");
    expect(json).toContain('"g"');
  });

  it("has nothing to describe for a note taken on empty space", () => {
    expect(describeCanvasSubtree(surface, [])).toBeUndefined();
  });
});
