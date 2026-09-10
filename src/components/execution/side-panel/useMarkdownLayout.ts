import { useLayoutEffect, useRef, useState } from "react";
import { useSettings, useSaveSettings } from "@/services/settings.service";
import { useScrollSync } from "./useScrollSync";
import {
  parseMarkdownEditLayout,
  resolveMarkdownLayout,
  MIN_SPLIT_PANE_PX,
  type MarkdownEditLayout,
} from "./file-edit-utils";

/**
 * How the markdown editor is arranged, and whether its two panes scroll together.
 *
 * Both are working preferences rather than per-file ones, so they live in app settings and survive
 * a restart. Each is also held locally, so a toggle responds on the click rather than after the
 * write round-trips; the render-time adjustments below adopt the stored value when it arrives, or
 * when another window changes it.
 */
export function useMarkdownLayout({
  isMarkdown,
  showsEditorSurface,
}: {
  isMarkdown: boolean;
  showsEditorSurface: boolean;
}) {
  const { data: appSettings } = useSettings();
  const saveSettings = useSaveSettings({ successToast: false });

  const storedLayout = parseMarkdownEditLayout(appSettings?.markdown_edit_layout);
  const [layout, setLayout] = useState<MarkdownEditLayout>(storedLayout);
  const [seenStoredLayout, setSeenStoredLayout] = useState(storedLayout);
  if (seenStoredLayout !== storedLayout) {
    setSeenStoredLayout(storedLayout);
    setLayout(storedLayout);
  }

  // Unset means on: the sync is the point of the split view, so it has to be the default a user
  // who has never touched the toggle gets.
  const storedScrollSync = appSettings?.markdown_scroll_sync ?? true;
  const [scrollSync, setScrollSync] = useState(storedScrollSync);
  const [seenStoredScrollSync, setSeenStoredScrollSync] = useState(storedScrollSync);
  if (seenStoredScrollSync !== storedScrollSync) {
    setSeenStoredScrollSync(storedScrollSync);
    setScrollSync(storedScrollSync);
  }

  // Two unreadable columns are worse than one readable one, so the split collapses below the width
  // where it earns its place. Measured before paint, so a user whose stored layout is split never
  // sees a frame of the other one.
  const editAreaRef = useRef<HTMLDivElement>(null);
  const [editAreaWidth, setEditAreaWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = editAreaRef.current;
    if (!element) return;
    setEditAreaWidth(element.offsetWidth);
    const observer = new ResizeObserver(([entry]) => {
      setEditAreaWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showsEditorSurface]);

  const effectiveLayout = resolveMarkdownLayout({
    layout,
    isMarkdown,
    availableWidth: editAreaWidth,
  });
  // Matches `resolveMarkdownLayout`: unmeasured and not-yet-laid-out both count as fitting, or the
  // button would be disabled for the frame before a hidden tab is shown.
  const splitFits =
    editAreaWidth === null || editAreaWidth <= 0 || editAreaWidth >= MIN_SPLIT_PANE_PX * 2;

  // State rather than refs: both elements are created by their children, after this hook's effects
  // would have run, so the sync has to re-render to pick them up.
  const [editorScroller, setEditorScroller] = useState<HTMLElement | null>(null);
  const [previewScroller, setPreviewScroller] = useState<HTMLDivElement | null>(null);
  useScrollSync(effectiveLayout === "split" && scrollSync, editorScroller, previewScroller);

  function chooseLayout(next: MarkdownEditLayout) {
    setLayout(next);
    if (appSettings) {
      saveSettings.mutate({ ...appSettings, markdown_edit_layout: next });
    }
  }

  function chooseScrollSync(next: boolean) {
    setScrollSync(next);
    if (appSettings) {
      saveSettings.mutate({ ...appSettings, markdown_scroll_sync: next });
    }
  }

  return {
    // `layout` itself is deliberately not returned: the UI binds to `effectiveLayout`, which is
    // the stored preference after the width check, and offering both invites binding to the wrong
    // one.
    chooseLayout,
    effectiveLayout,
    splitFits,
    scrollSync,
    chooseScrollSync,
    editAreaRef,
    setEditorScroller,
    setPreviewScroller,
  };
}
