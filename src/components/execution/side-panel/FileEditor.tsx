import { useEffect, useRef } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  highlightSpecialChars,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap,
  LanguageDescription,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { githubTheme } from "@/lib/codemirror-github-theme";
import { useTheme } from "@/providers/ThemeProvider";
import type { LineRange } from "@/lib/path-utils";

/**
 * Structure only — every colour lives in `githubTheme`. The two are separate because the layout
 * belongs to the panel (the type size and line height the Files tab has always used) while the
 * colours belong to the theme the rest of the app renders code with.
 */
const BASE_THEME = EditorView.theme({
  "&": { fontSize: "0.75rem", height: "100%" },
  ".cm-scroller": {
    fontFamily: '"FiraCode Nerd Font Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
    lineHeight: "1.5",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.5rem",
    paddingRight: "1rem",
  },
  "&.cm-focused": { outline: "none" },
});

/** How long `.cm-flash-line` runs in `index.css`; the decoration is taken off once it has. */
const FLASH_MS = 1600;
const FLASH_LINE = Decoration.line({ class: "cm-flash-line" });

/**
 * Lines a link pointed at, briefly tinted so the eye finds them after the jump. A decoration rather
 * than a class on the DOM line, because CodeMirror recreates those lines as they scroll in and out
 * of view; `null` takes it off again.
 */
const setFlash = StateEffect.define<LineRange | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(flash, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue;
      if (!effect.value) return Decoration.none;
      const { doc } = tr.state;
      const lines = [];
      for (let n = effect.value.from; n <= Math.min(effect.value.to, doc.lines); n++) {
        lines.push(FLASH_LINE.range(doc.line(n).from));
      }
      return Decoration.set(lines);
    }
    return flash.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * What editing adds on top of reading. `drawSelection` is in here rather than always on so read
 * mode uses the browser's own selection and shows no caret — with nothing to type into, a blinking
 * cursor would claim otherwise.
 */
function editingExtensions(enabled: boolean, save: () => void): Extension {
  if (!enabled) return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  return [
    EditorState.readOnly.of(false),
    EditorView.editable.of(true),
    drawSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    keymap.of([{ key: "Mod-s", preventDefault: true, run: () => (save(), true) }]),
  ];
}

interface FileEditorProps {
  /**
   * While `readOnly`, this is the document and the editor follows it — the panel's poll picking up
   * an agent's write lands here. While editable it is the *starting* document: feeding the draft
   * back down on every keystroke would fight the editor's own state and lose the cursor, so the
   * parent owns the draft through `onChange` and re-seeds it by bumping `docEpoch`.
   */
  doc: string;
  /** Bump to make an editable editor take `doc` again — reloading after a conflict. */
  docEpoch: number;
  /** Drives the language mode, and rebuilds the editor when the user selects another file. */
  fileName: string;
  /**
   * Read mode. The same editor renders both modes so the two cannot disagree about colour; the
   * caret and the active-line highlight are what tell the user which one they are in.
   */
  readOnly?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  /**
   * Hands out CodeMirror's own scrolling element, which the library creates — there is no way to
   * put a ref or a class on it from here. Called with `null` when the view is torn down.
   */
  onScrollerChange?: (element: HTMLElement | null) => void;
  /** Lines to scroll to and flash, once per file, as soon as the document is long enough to have them. */
  revealLines?: LineRange;
  /** Changed to flash `revealLines` again, for a link to the same lines followed a second time. */
  revealKey?: number;
}

export function FileEditor({
  doc,
  docEpoch,
  fileName,
  readOnly = false,
  onChange,
  onSave,
  onScrollerChange,
  revealLines,
  revealKey,
}: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());

  // Callbacks and the document go through refs so a re-render of the parent never rebuilds the
  // editor — that would discard undo history and the cursor on every keystroke, since `onChange`
  // sets parent state. `doc` in particular changes on every save, when the parent re-baselines.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const docRef = useRef(doc);
  const onScrollerChangeRef = useRef(onScrollerChange);

  // Declared before the effects that read them, so a mount has current values in hand.
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    docRef.current = doc;
    onScrollerChangeRef.current = onScrollerChange;
  });

  const { theme, systemTheme } = useTheme();
  const isDark = (theme === "system" ? systemTheme : theme) === "dark";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: docRef.current,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          highlightSelectionMatches(),
          history(),
          foldGutter(),
          indentOnInput(),
          bracketMatching(),
          EditorState.allowMultipleSelections.of(true),
          editableCompartment.current.of([]),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          languageCompartment.current.of([]),
          themeCompartment.current.of([]),
          BASE_THEME,
          flashField,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    onScrollerChangeRef.current?.(view.scrollDOM);

    return () => {
      onScrollerChangeRef.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, [fileName]);

  // Grammars are dynamic imports, so the editor opens in plain text and gains highlighting a beat
  // later. A file whose extension no language claims stays plain, which is correct rather than a
  // failure worth reporting.
  useEffect(() => {
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, fileName);
    if (!description) {
      viewRef.current?.dispatch({
        effects: languageCompartment.current.reconfigure([]),
      });
      return;
    }
    description
      .load()
      .then((support) => {
        if (cancelled) return;
        viewRef.current?.dispatch({
          effects: languageCompartment.current.reconfigure(support as Extension),
        });
      })
      .catch(() => {
        // Plain text is a working editor; a missing grammar is not worth interrupting the user.
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(githubTheme(isDark)),
    });
  }, [isDark]);

  // Reconfiguring rather than remounting is the point: the mode toggle keeps the same view, so the
  // scroll position and the selection survive it and nothing repaints.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.current.reconfigure(
        editingExtensions(!readOnly, () => onSaveRef.current()),
      ),
    });
    if (!readOnly) view.focus();
  }, [readOnly, fileName]);

  // Read mode follows `doc`, so the panel's poll shows an agent's write. Edit mode only takes it
  // when asked to, which is what `docEpoch` is for — otherwise re-baselining after a save would
  // reset the buffer under the user.
  const appliedEpochRef = useRef(docEpoch);
  const appliedDocRef = useRef(doc);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const epochChanged = appliedEpochRef.current !== docEpoch;
    const docChanged = appliedDocRef.current !== doc;
    appliedEpochRef.current = docEpoch;
    appliedDocRef.current = doc;
    if (!epochChanged && !(readOnly && docChanged)) return;
    if (view.state.doc.toString() === doc) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  }, [doc, docEpoch, readOnly]);

  // After the effect above, so it sees the document that just landed. Once per view and range, so
  // the panel's poll does not yank the view back after the user has scrolled away. Per view, not
  // per component: StrictMode builds the view twice, and a guard that outlived the first one
  // skipped the second, which is the one on screen.
  const revealedRef = useRef<{ view: EditorView; key: string } | null>(null);
  const revealFrom = revealLines?.from;
  const revealTo = revealLines?.to;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealFrom || !revealTo) return;
    const key = `${revealKey}:${revealFrom}-${revealTo}`;
    const revealed = revealedRef.current;
    if ((revealed?.view === view && revealed.key === key) || revealFrom > view.state.doc.lines) {
      return;
    }
    revealedRef.current = { view, key };
    const pos = view.state.doc.line(revealFrom).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: [
        EditorView.scrollIntoView(pos, { y: "center" }),
        setFlash.of({ from: revealFrom, to: revealTo }),
      ],
    });
    // Not cleared on re-run: the poll changes `doc`, and cancelling here would leave the tint on.
    // A view torn down in the meantime is no longer `viewRef.current`, and is left alone.
    window.setTimeout(() => {
      if (viewRef.current === view) view.dispatch({ effects: setFlash.of(null) });
    }, FLASH_MS);
  }, [revealFrom, revealTo, revealKey, doc]);

  return <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden [&_.cm-editor]:h-full" />;
}
