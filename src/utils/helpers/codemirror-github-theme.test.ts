import { describe, it, expect } from "vitest";
import { tags as t, highlightTree, type Tag } from "@lezer/highlight";
import type { HighlightStyle } from "@codemirror/language";
import { typescriptLanguage } from "@codemirror/lang-javascript";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import {
  githubHighlightStyle,
  githubPalette,
  SELECTION_BG,
  SELECTION_SELECTORS,
} from "./codemirror-github-theme";

interface TokenRule {
  settings?: { foreground?: string };
}

/**
 * Every foreground the theme defines, so a colour in our table can be checked against the file it
 * claims to have been copied from. This is what catches both a typo and an upstream palette change
 * — `@uiw/codemirror-theme-github`, which this replaced, silently shipped the *modern* GitHub
 * palette under the same name.
 */
function foregrounds(theme: unknown): Set<string> {
  // `tokenColors` on the raw theme JSON; shiki renames it to `settings` when it normalises a
  // theme, and we may be handed either.
  const t = theme as { tokenColors?: TokenRule[]; settings?: TokenRule[] };
  const rules = t.tokenColors ?? t.settings ?? [];
  const out = new Set<string>();
  for (const rule of rules) {
    const fg = rule.settings?.foreground;
    if (fg) out.add(fg.toLowerCase());
  }
  return out;
}

/**
 * The colour a tag actually resolves to, rather than the colour we wrote down for it.
 *
 * These differ whenever a tag carries modifiers: `function(definition(variableName))` matches a
 * rule for itself, for `function(variableName)`, for `definition(variableName)` and for
 * `variableName`, and only the first one found wins. Reading the spec array would not notice the
 * wrong one winning; asking the built `HighlightStyle` does.
 */
function colorForClasses(style: HighlightStyle, classes: string): string | null {
  const css = style.module?.getRules() ?? "";
  for (const name of classes.split(" ").filter(Boolean)) {
    const rule = css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`));
    const color = rule?.[1].match(/(?:^|[;{]\s*)color:\s*([^;]+)/);
    if (color) return color[1].trim().toLowerCase();
  }
  return null;
}

function colorOf(style: HighlightStyle, tag: Tag): string | null {
  const classes = style.style([tag]);
  return classes ? colorForClasses(style, classes) : null;
}

/**
 * What the editor would actually paint, by running the real TypeScript grammar over a snippet and
 * asking the style for every range it produces.
 *
 * The tag-level checks above verify the table; this verifies that the table and the grammar are
 * talking about the same things. It is also what would catch two copies of `@lezer/highlight` in
 * the tree — different `Tag` identities, every rule silently missing its target.
 */
function paint(code: string, style: HighlightStyle): Map<string, string | null> {
  const tree = typescriptLanguage.parser.parse(code);
  const painted = new Map<string, string | null>();
  highlightTree(tree, style, (from, to, classes) => {
    painted.set(code.slice(from, to), colorForClasses(style, classes));
  });
  return painted;
}

describe("the CodeMirror GitHub theme", () => {
  const dark = githubHighlightStyle(true);
  const light = githubHighlightStyle(false);

  it("uses only colours that exist in the shiki theme it mirrors", () => {
    for (const [isDark, theme] of [
      [true, githubDark],
      [false, githubLight],
    ] as const) {
      const allowed = foregrounds(theme);
      const palette = githubPalette(isDark);
      // The chrome colours come from `theme.colors`, not the token rules, so they are checked
      // separately below.
      const { caret, matchHighlight, ...tokens } = palette;
      void caret;
      void matchHighlight;
      // Reported as a list rather than one assertion per entry, so a failure names every colour
      // that drifted instead of stopping at the first.
      const missing = Object.entries(tokens)
        .filter(([, color]) => !allowed.has(color.toLowerCase()))
        .map(([name, color]) => `${isDark ? "dark" : "light"} ${name} = ${color}`);
      expect(missing).toEqual([]);
    }
  });

  it("takes its caret and find-match tints from the theme's editor colours", () => {
    for (const [isDark, theme] of [
      [true, githubDark],
      [false, githubLight],
    ] as const) {
      const colors = (theme as { colors?: Record<string, string> }).colors ?? {};
      const palette = githubPalette(isDark);
      expect(palette.caret).toBe(colors["editorCursor.foreground"]);
      expect(palette.matchHighlight).toBe(colors["editor.findMatchHighlightBackground"]);
    }
  });

  /// Read mode selects natively and edit mode paints `.cm-selectionBackground` divs, so the two
  /// only agree if both are covered — and the drawn one only wins if it out-specifies CodeMirror's
  /// own, which is six classes deep. Losing either is invisible in a unit test but obvious the
  /// moment someone drags across a line.
  it("selects in the app's accent, in both modes", () => {
    expect(SELECTION_BG).toContain("var(--accent)");
    // Read mode: the browser's own selection.
    expect(SELECTION_SELECTORS.some((s) => s.includes("::selection"))).toBe(true);
    // Edit mode: the layer `drawSelection` paints instead.
    expect(SELECTION_SELECTORS.some((s) => s.includes(".cm-selectionLayer"))).toBe(true);
  });

  it("keeps the drawn selection specific enough to beat CodeMirror's base theme", () => {
    const drawn = SELECTION_SELECTORS.find((s) => s.includes(".cm-selectionLayer"))!;
    // `&` expands to the theme's own generated class, so it counts as one on top of the dots.
    const classes = (drawn.match(/\./g)?.length ?? 0) + (drawn.startsWith("&") ? 1 : 0);
    expect(classes).toBeGreaterThanOrEqual(6);
  });

  // The bug this file was written to fix. `@uiw` painted identifiers `#79c0ff` and properties
  // `#d2a8ff`, so a page of TypeScript was mostly blue and purple where the read view showed it
  // mostly plain. If either of these regresses, the two views drift apart again.
  it("leaves plain identifiers and properties at the editor foreground", () => {
    for (const [style, isDark] of [
      [dark, true],
      [light, false],
    ] as const) {
      const { foreground } = githubPalette(isDark);
      expect(colorOf(style, t.variableName)).toBe(foreground.toLowerCase());
      expect(colorOf(style, t.propertyName)).toBe(foreground.toLowerCase());
      expect(colorOf(style, t.definition(t.variableName))).toBe(foreground.toLowerCase());
      // `special(propertyName)` (a JS private field, a PHP member) has no rule of its own and has
      // to fall back through its tag set rather than landing somewhere else.
      expect(colorOf(style, t.special(t.propertyName))).toBe(foreground.toLowerCase());
    }
  });

  it("colours a function the same at its call site and its declaration", () => {
    for (const [style, isDark] of [
      [dark, true],
      [light, false],
    ] as const) {
      const { entity } = githubPalette(isDark);
      // `CallExpression/VariableName`
      expect(colorOf(style, t.function(t.variableName))).toBe(entity.toLowerCase());
      // `CallExpression/MemberExpression/PropertyName`
      expect(colorOf(style, t.function(t.propertyName))).toBe(entity.toLowerCase());
      // `FunctionDeclaration/VariableDefinition` — the composed tag whose set also contains the
      // foreground rule for `definition(variableName)`.
      expect(colorOf(style, t.function(t.definition(t.variableName)))).toBe(entity.toLowerCase());
      expect(colorOf(style, t.definition(t.className))).toBe(entity.toLowerCase());
    }
  });

  it("treats operators as keywords and punctuation as foreground, the way TextMate scopes them", () => {
    for (const [style, isDark] of [
      [dark, true],
      [light, false],
    ] as const) {
      const { keyword, foreground } = githubPalette(isDark);
      // `keyword.operator.*` prefix-matches the theme's `keyword` rule.
      expect(colorOf(style, t.definitionOperator)).toBe(keyword.toLowerCase());
      expect(colorOf(style, t.compareOperator)).toBe(keyword.toLowerCase());
      // The arrow of an arrow function, tagged `function(punctuation)` — keyword, not punctuation.
      expect(colorOf(style, t.function(t.punctuation))).toBe(keyword.toLowerCase());
      // `.` is the exception among the operator tags: Lezer derives `derefOperator` from
      // `operator`, so it needs a rule of its own or it inherits the keyword colour.
      expect(colorOf(style, t.derefOperator)).toBe(foreground.toLowerCase());
      // `punctuation.*` gets no rule in the theme, so these must resolve to nothing and inherit.
      expect(colorOf(style, t.punctuation)).toBeNull();
      expect(colorOf(style, t.separator)).toBeNull();
      expect(colorOf(style, t.brace)).toBeNull();
      expect(colorOf(style, t.squareBracket)).toBeNull();
    }
  });

  /// End to end against the real grammar, which is the form the complaint arrived in: a page of
  /// TypeScript came out mostly blue and purple in the editor where the read view showed it mostly
  /// plain. Every expectation here is what `github-dark` produces for the same snippet.
  it("paints a snippet of TypeScript the way the theme does", () => {
    const { foreground, keyword, entity, string, constant, comment } = githubPalette(true);
    const painted = paint(
      [
        "// note",
        "const total = items.length;",
        'export function run(): string { return fetchData(total) ?? "x"; }',
      ].join("\n"),
      dark,
    );

    expect(painted.get("// note")).toBe(comment.toLowerCase());
    expect(painted.get("const")).toBe(keyword.toLowerCase());
    expect(painted.get("export")).toBe(keyword.toLowerCase());
    expect(painted.get("return")).toBe(keyword.toLowerCase());
    expect(painted.get("=")).toBe(keyword.toLowerCase());
    // A declaration and a call site of the same kind of thing, both entity-coloured.
    expect(painted.get("run")).toBe(entity.toLowerCase());
    expect(painted.get("fetchData")).toBe(entity.toLowerCase());
    // The two the old theme got wrong: a plain binding and a property access.
    expect(painted.get("total")).toBe(foreground.toLowerCase());
    expect(painted.get("items")).toBe(foreground.toLowerCase());
    expect(painted.get("length")).toBe(foreground.toLowerCase());
    expect(painted.get(".")).toBe(foreground.toLowerCase());
    expect(painted.get('"x"')).toBe(string.toLowerCase());
    // A known and deliberate divergence, pinned so it is a decision rather than a surprise.
    // GitHub scopes a built-in type `support.type.primitive` and colours it `constant`, while a
    // user-defined one is `entity.name.type`. Lezer's TypeScript grammar tags both `typeName` and
    // emits no `standard(typeName)`, so one of the two has to be wrong: application code annotates
    // far more interfaces and aliases than primitives, so the entity colour is the one to keep.
    expect(painted.get("string")).toBe(entity.toLowerCase());
    expect(constant).not.toBe(entity);
    // Braces, parens and semicolons are never given a rule, so they never reach this map.
    expect(painted.has("{")).toBe(false);
    expect(painted.has(";")).toBe(false);
  });

  it("covers the same tags in light as in dark", () => {
    const probes: [string, Tag][] = [
      ["comment", t.comment],
      ["variableName", t.variableName],
      ["propertyName", t.propertyName],
      ["function(variableName)", t.function(t.variableName)],
      ["className", t.className],
      ["typeName", t.typeName],
      ["keyword", t.keyword],
      ["controlKeyword", t.controlKeyword],
      ["string", t.string],
      ["number", t.number],
      ["bool", t.bool],
      ["self", t.self],
      ["escape", t.escape],
      ["regexp", t.regexp],
      ["tagName", t.tagName],
      ["attributeName", t.attributeName],
      ["attributeValue", t.attributeValue],
      ["heading", t.heading],
      ["quote", t.quote],
      ["list", t.list],
      ["link", t.link],
      ["invalid", t.invalid],
      ["unit", t.unit],
      ["processingInstruction", t.processingInstruction],
    ];
    expect(probes.filter(([, tag]) => colorOf(dark, tag) === null).map(([name]) => name)).toEqual(
      [],
    );
    expect(
      probes
        .filter(([, tag]) => (colorOf(light, tag) === null) !== (colorOf(dark, tag) === null))
        .map(([name]) => name),
    ).toEqual([]);
  });
});
