import { useEffect, useRef, useState } from "react";
import { readFile, useWriteFile } from "@/services/connection.service";
import { decideSave } from "./file-edit-utils";
import type { ConnectionKey } from "@/types/bindings";

interface UseFileDraftOptions {
  connection: ConnectionKey;
  /** Absolute path of the open file, or `null` when nothing is open. */
  fullPath: string | null;
  /** Lets the panel's own tab refuse to close while an unsaved draft is open. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The edit buffer and everything that can end it.
 *
 * `baseline` is what the file held when editing started and is what a save compares against to
 * notice the agent writing underneath; `draft` is the buffer. `docEpoch` is bumped whenever the
 * editor has to take the document again — reloading after a conflict.
 *
 * The file's contents are passed in per call rather than held here, and `leaveEdit` reports
 * whether it left rather than refetching itself. That is what lets the panel call this *above* its
 * read query: the query's poll interval reads `mode`, so a hook that needed the query's result
 * would leave `mode` in the temporal dead zone inside that callback.
 */
export function useFileDraft({ connection, fullPath, onDirtyChange }: UseFileDraftOptions) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [baseline, setBaseline] = useState("");
  const [draft, setDraft] = useState("");
  const [docEpoch, setDocEpoch] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ onDisk: string } | null>(null);
  const [saving, setSaving] = useState(false);
  /** The user tried to leave edit mode with unsaved changes and is being asked first. */
  const [discardPrompt, setDiscardPrompt] = useState(false);

  const writeFile = useWriteFile();
  const isDirty = mode === "edit" && draft !== baseline;

  // Through a ref so the parent can pass an inline callback bound to this tab's id without
  // re-firing the report on every render.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(isDirty);
  }, [isDirty]);

  // Moving to another file must not leave edit mode pointing at a path that is no longer the one
  // being edited. Adjusted during render rather than from an effect — this is state reacting to a
  // changed input, the same shape `useSidePanelTabs` uses for its settled diff count.
  const [editingPath, setEditingPath] = useState(fullPath);
  if (editingPath !== fullPath) {
    setEditingPath(fullPath);
    setMode("view");
    setSaveError(null);
    setConflict(null);
  }

  function enterEdit(content: string | null | undefined) {
    if (content == null) return;
    setBaseline(content);
    setDraft(content);
    setDocEpoch((e) => e + 1);
    setSaveError(null);
    setMode("edit");
  }

  /**
   * Returns whether it actually left. A dirty buffer raises the discard prompt instead, and the
   * caller must not refetch over an edit the user has not decided about yet.
   */
  function leaveEdit(): boolean {
    if (isDirty) {
      setDiscardPrompt(true);
      return false;
    }
    setMode("view");
    setSaveError(null);
    return true;
  }

  /** Leaves edit mode without saving. */
  function discardDraft() {
    setDiscardPrompt(false);
    setMode("view");
    setSaveError(null);
  }

  async function commit(contents: string) {
    if (!fullPath) return;
    await writeFile.mutateAsync({ connection, path: fullPath, contents });
    setBaseline(contents);
    setSaveError(null);
  }

  /** Resolves to whether the draft is now on disk; a conflict or a failed write leaves it unsaved. */
  async function handleSave(): Promise<boolean> {
    // `disabled` on a base-ui `TooltipTrigger` becomes `data-trigger-disabled`, not the DOM
    // attribute, so the button stays clickable and the guard has to live here. Saving a clean
    // buffer would otherwise raise a conflict dialog over an edit the user never made.
    if (!fullPath || saving) return false;
    if (!isDirty) return true;
    setSaving(true);
    setSaveError(null);
    try {
      const onDisk = await readFile(connection, fullPath);
      const decision = decideSave({ baseline, draft, onDisk });
      if (decision.kind === "unchanged") {
        setBaseline(draft);
      } else if (decision.kind === "conflict") {
        setConflict({ onDisk });
        return false;
      } else {
        await commit(draft);
      }
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleOverwrite() {
    setConflict(null);
    setSaving(true);
    try {
      await commit(draft);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleReloadFromDisk(onDisk: string) {
    setConflict(null);
    setBaseline(onDisk);
    setDraft(onDisk);
    setDocEpoch((e) => e + 1);
    setSaveError(null);
  }

  return {
    mode,
    draft,
    setDraft,
    docEpoch,
    saveError,
    conflict,
    setConflict,
    saving,
    isDirty,
    discardPrompt,
    setDiscardPrompt,
    discardDraft,
    enterEdit,
    leaveEdit,
    handleSave,
    handleOverwrite,
    handleReloadFromDisk,
  };
}
