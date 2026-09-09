/**
 * CodeMirror rendering of Shiki's `github-dark` / `github-light`.
 *
 * The Files tab shows one file through one editor, so there is only one place colours come from —
 * but the *rest* of the app (the diff view, the agent activity stream) still renders code with
 * Shiki and those two themes. This file exists so the two agree.
 *
 * It replaces `@uiw/codemirror-theme-github`, which disagreed twice over:
 *
 *  - It ports the **modern** GitHub palette (`#ff7b72`, `#a5d6ff`, `#d2a8ff`, `#c9d1d9`). Shiki's
 *    `github-dark` is the **legacy** one (`#f97583`, `#9ecbff`, `#b392f0`, `#e1e4e8`), so colours
 *    differed even where the two agreed on which token was which.
 *  - It is fifteen rules over Lezer's tag set; the theme it names has forty-five. Most visibly it
 *    painted every identifier blue and every `foo.bar` purple, where GitHub leaves both at the
 *    editor foreground and reserves purple for function names.
 *
 * Every colour below is copied from `@shikijs/themes/github-{dark,light}` and carries the TextMate
 * scope it came from, so a reader can check it against the source. `codemirror-github-theme.test.ts`
 * checks it mechanically.
 *
 * Tags with no rule fall back through their own tag set — `special(string)` finds `string`,
 * `special(propertyName)` finds `propertyName` — so composed tags are only listed where the
 * fallback would land on the wrong colour.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

export interface GithubPalette {
  /** `editor.foreground`, and the colour `variable.other` is pinned to. */
  foreground: string;
  /** `comment`, `punctuation.definition.comment` */
  comment: string;
  /** `constant`, `variable.language`, `support`, `meta.property-name` */
  constant: string;
  /** `entity`, `entity.name` */
  entity: string;
  /** `keyword`, `storage`, `storage.type` — and `keyword.operator.*`, see below. */
  keyword: string;
  /** `string`, `punctuation.definition.string` */
  string: string;
  /** `entity.name.tag`, `markup.quote`, `markup.inserted` */
  tag: string;
  /** bare `variable`, `markup.changed`, `punctuation.definition.list.begin.markdown` */
  variable: string;
  /** `source.regexp`, `string.regexp`, `string.other.link` */
  regexp: string;
  /** `invalid.*`, `markup.deleted` */
  invalid: string;
  /** `editorCursor.foreground` */
  caret: string;
  /** `editor.findMatchHighlightBackground` */
  matchHighlight: string;
}

/**
 * What a selection looks like, and deliberately not GitHub's `editor.selectionBackground`.
 *
 * Selecting text is app chrome, not syntax: `index.css` paints every selection in the app with
 * this, and a code pane that answered in GitHub blue instead would be the only place in Maestro
 * that disagreed about what "selected" looks like.
 */
export const SELECTION_BG = "color-mix(in oklch, var(--accent) 35%, transparent)";

/**
 * The three places a selection is painted, which is two more than it looks.
 *
 * Read mode uses the browser's own selection — `.cm-content ::selection` is all that needs saying.
 * Edit mode turns on `drawSelection`, which hides the native one and paints `.cm-selectionBackground`
 * divs in a layer instead, with one rule for the focused editor and one for the unfocused.
 *
 * **The `.cm-editor` is load-bearing.** CodeMirror's base theme colours the drawn layer through
 * `&dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground` — six classes,
 * where a bare `&` prefix gives five — so without the extra class the library's own grey wins and
 * the two modes disagree, which is exactly what they did. A tie is enough: theme modules mount
 * after base themes.
 */
export const SELECTION_SELECTORS = [
  "&.cm-editor .cm-selectionBackground",
  "&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground",
  ".cm-content ::selection",
];

const DARK: GithubPalette = {
  foreground: "#e1e4e8",
  comment: "#6a737d",
  constant: "#79b8ff",
  entity: "#b392f0",
  keyword: "#f97583",
  string: "#9ecbff",
  tag: "#85e89d",
  variable: "#ffab70",
  regexp: "#dbedff",
  invalid: "#fdaeb7",
  caret: "#c8e1ff",
  matchHighlight: "#ffd33d22",
};

const LIGHT: GithubPalette = {
  foreground: "#24292e",
  comment: "#6a737d",
  constant: "#005cc5",
  entity: "#6f42c1",
  keyword: "#d73a49",
  string: "#032f62",
  tag: "#22863a",
  variable: "#e36209",
  regexp: "#032f62",
  invalid: "#b31d28",
  caret: "#044289",
  matchHighlight: "#ffdf5d66",
};

export function githubPalette(isDark: boolean): GithubPalette {
  return isDark ? DARK : LIGHT;
}

export function githubHighlightStyle(isDark: boolean) {
  const p = githubPalette(isDark);
  return HighlightStyle.define([
    // comment, punctuation.definition.comment, string.comment
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comment },

    // variable.other — the identifiers GitHub leaves at the editor foreground. Stated as a rule
    // rather than left to inherit, because these are precisely what the old theme got wrong.
    { tag: [t.variableName, t.propertyName, t.definition(t.variableName)], color: p.foreground },
    { tag: [t.definition(t.propertyName), t.content], color: p.foreground },

    // entity, entity.name — anything GitHub treats as a named thing: functions at their call and
    // declaration sites, classes, types, namespaces, macros and labels.
    //
    // `typeName` is the one place this cannot be exact. GitHub colours a built-in type
    // (`support.type.primitive`, so `string` and `number`) like a constant and a user-defined one
    // like an entity, but Lezer's TypeScript grammar tags both `typeName` and never emits
    // `standard(typeName)`. Application code annotates far more interfaces and aliases than
    // primitives, so entity is the side to be right about.
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        // `FunctionDeclaration/VariableDefinition` is `function(definition(variableName))`, whose
        // tag set also contains `definition(variableName)`. Without this the foreground rule above
        // could win and declarations would not match their call sites.
        t.function(t.definition(t.variableName)),
        t.className,
        t.definition(t.className),
        t.typeName,
        t.definition(t.typeName),
        t.namespace,
        t.macroName,
        t.labelName,
      ],
      color: p.entity,
    },

    // keyword, storage, storage.type
    {
      tag: [
        t.keyword,
        t.controlKeyword,
        t.definitionKeyword,
        t.moduleKeyword,
        t.operatorKeyword,
        t.modifier,
      ],
      color: p.keyword,
    },

    // TextMate scopes operators `keyword.operator.*`, which prefix-matches the `keyword` rule — so
    // `=`, `+`, `&&` and `=>` are all keyword-coloured in GitHub, not foreground. The old theme put
    // them in the same group as variables, which is where much of the blue came from.
    //
    // `,` is absent: TextMate scopes it `punctuation.separator`, which GitHub leaves at the
    // foreground, and Lezer's `separator` descends from `punctuation` so it inherits nothing.
    // `.` needs the explicit rule below instead, because `derefOperator` descends from `operator`.
    {
      tag: [
        t.operator,
        t.arithmeticOperator,
        t.logicOperator,
        t.bitwiseOperator,
        t.compareOperator,
        t.updateOperator,
        t.definitionOperator,
        t.typeOperator,
        t.controlOperator,
        // The arrow of an arrow function, tagged `function(punctuation)`. TextMate calls it
        // `storage.type.function.arrow`, so it is keyword-coloured; the fallback would find
        // `punctuation` and leave it at the foreground.
        t.function(t.punctuation),
      ],
      color: p.keyword,
    },

    // `punctuation.accessor` — the `.` of `foo.bar`, and Rust's and C++'s `->`. Lezer derives
    // `derefOperator` from `operator`, so without a rule of its own it would inherit the keyword
    // colour from the group above; TextMate calls it punctuation and GitHub leaves it plain.
    { tag: t.derefOperator, color: p.foreground },

    // string, punctuation.definition.string
    { tag: [t.string, t.character, t.docString, t.attributeValue], color: p.string },

    // constant, entity.name.constant, variable.other.constant, variable.other.enummember,
    // variable.language — plus `support`, `support.constant`, `support.variable` and
    // `meta.property-name`, which GitHub gives the same colour.
    {
      tag: [
        t.number,
        t.integer,
        t.float,
        t.bool,
        t.null,
        t.atom,
        t.self,
        t.color,
        t.constant(t.variableName),
        t.standard(t.variableName),
        t.standard(t.typeName),
        t.attributeName,
        // `constant.character.escape`. GitHub's green-and-bold escape rule is scoped
        // `string.regexp constant.character.escape` — regexps only — and Lezer cannot make that
        // distinction, so the general case wins.
        t.escape,
      ],
      color: p.constant,
    },

    // keyword.other.unit — CSS units read as keywords, not as part of the number.
    { tag: t.unit, color: p.keyword },

    // entity.name.tag
    { tag: [t.tagName, t.standard(t.tagName)], color: p.tag },

    // source.regexp, string.regexp
    { tag: t.regexp, color: p.regexp },

    // keyword.control.directive — C's preprocessor and PHP's open tag.
    { tag: t.processingInstruction, color: p.keyword },

    // invalid.broken, invalid.deprecated, invalid.illegal, invalid.unimplemented
    { tag: t.invalid, color: p.invalid, fontStyle: "italic" },

    // markup.* — markdown source, which the Files tab shows whenever the split view is open.
    {
      tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6],
      color: p.constant,
      fontWeight: "bold",
    },
    { tag: t.quote, color: p.tag },
    { tag: t.list, color: p.variable },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.monospace, color: p.constant },
    { tag: [t.link, t.url], color: p.regexp, textDecoration: "underline" },
    { tag: t.contentSeparator, color: p.constant, fontWeight: "bold" },
    { tag: t.inserted, color: p.tag },
    { tag: t.deleted, color: p.invalid },
    { tag: t.changed, color: p.variable },
  ]);
}

/**
 * The chrome the theme has to supply — caret, selection, active line, gutter.
 *
 * Background and gutter background stay transparent and the gutter text stays on our own CSS
 * variables: the editor sits inside a panel that already has a background, and painting GitHub's
 * `#24292e` over it would leave a rectangle that does not match anything around it. Everything
 * that is genuinely part of the syntax theme — the caret, the find-match tint — comes from the
 * theme JSON; the selection is app chrome and comes from [`SELECTION_BG`].
 */
function editorChrome(p: GithubPalette, isDark: boolean) {
  return EditorView.theme(
    {
      "&": { color: p.foreground, backgroundColor: "transparent" },
      ".cm-content": { caretColor: p.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.caret },
      [SELECTION_SELECTORS.join(", ")]: { backgroundColor: SELECTION_BG },
      ".cm-selectionMatch": { backgroundColor: p.matchHighlight },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in oklch, var(--foreground) 6%, transparent)",
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "oklch(from var(--muted-foreground) l c h / 0.45)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
      },
      "&.cm-focused .cm-matchingBracket, .cm-matchingBracket": {
        backgroundColor: "color-mix(in oklch, var(--foreground) 12%, transparent)",
        outline: "none",
      },
      ".cm-nonmatchingBracket": { color: p.invalid },
    },
    { dark: isDark },
  );
}

/** Everything the editor needs to look like Shiki's `github-dark` / `github-light`. */
export function githubTheme(isDark: boolean): Extension {
  return [
    editorChrome(githubPalette(isDark), isDark),
    syntaxHighlighting(githubHighlightStyle(isDark)),
  ];
}
