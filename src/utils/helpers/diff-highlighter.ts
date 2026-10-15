/**
 * The syntax highlighter behind every diff and every code block in the app.
 *
 * `@git-diff-view/lezer` parses with the Lezer grammars the Files tab's editor already uses, and is
 * painted with the editor's own rules (`githubTokenColors`), so code reads the same in all three.
 * It replaced Shiki, whose TextMate tokenizing measured 12–127x slower on this repository's own
 * files: 200ms to 900ms a card, synchronous, where Lezer takes 7ms to 30ms.
 *
 * The package ships seventeen grammars. Anything else is looked up in `@codemirror/language-data`,
 * the registry the editor resolves file names against, and loaded on demand.
 */
import {
  getCssVarHighlighter,
  getDiffViewHighlighter,
  registerLanguage,
  type DiffHighlighter,
} from "@git-diff-view/lezer";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";
import { githubPalette, githubTokenColors } from "@/lib/codemirror-github-theme";

/**
 * What `detectLanguage` in `diff-utils.ts` can name that the package has no grammar for.
 *
 * Loaded before the highlighter resolves, because `@git-diff-view/core` asks for a grammar
 * synchronously: a file whose grammar is not registered yet falls back to the lowlight stub and
 * stays plain.
 */
const DIFF_EXTRA_LANGS = ["csharp", "bash", "sql"];

/**
 * Files longer than this render plain. The package defaults to 2000, which was Shiki's budget; a
 * diff is now tokenized against its whole file (see `ExpandableDiffViewer`), and Lezer gets through
 * 4500 lines in under 70ms.
 */
const MAX_LINES = 10_000;

const loading = new Map<string, Promise<boolean>>();

/** Registers a grammar for `lang` if `@codemirror/language-data` has one, and says whether it did. */
function ensureLanguage(highlighter: DiffHighlighter, lang: string): Promise<boolean> {
  if (highlighter.hasRegisteredCurrentLang(lang)) return Promise.resolve(true);
  let pending = loading.get(lang);
  if (!pending) {
    const description = LanguageDescription.matchLanguageName(languages, lang);
    pending = description
      ? description.load().then(
          ({ language }) => {
            registerLanguage({ name: lang, parse: (input) => language.parser.parse(input) });
            return true;
          },
          () => false,
        )
      : Promise.resolve(false);
    loading.set(lang, pending);
  }
  return pending;
}

let highlighterPromise: Promise<DiffHighlighter> | null = null;

export function getDiffHighlighter() {
  highlighterPromise ??= (async () => {
    const highlighter = await getDiffViewHighlighter({ tokenColors: githubTokenColors() });
    highlighter.setMaxLineToIgnoreSyntax(MAX_LINES);
    await Promise.all(DIFF_EXTRA_LANGS.map((lang) => ensureLanguage(highlighter, lang)));
    return highlighter;
  })();
  return highlighterPromise;
}

export type DiffHighlighterInstance = DiffHighlighter;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * `code` as a standalone `<pre>`, in one theme, for the code blocks outside the diff view.
 *
 * Keeps the markup Shiki's `codeToHtml` produced: a `pre` carrying GitHub's background and
 * foreground (`stripContainerStyle` callers remove it), and one `span.line` per line, which the
 * line numbers in `.file-code-view` count. A language with no grammar still gets that markup,
 * uncoloured.
 */
export async function highlightToHtml(code: string, lang: string, isDark: boolean) {
  const highlighter = await getDiffHighlighter();
  const lines = [""];
  if (await ensureLanguage(highlighter, lang)) {
    const tree = highlighter.getHighlighterEngine().get(lang).parse(code);
    // A token's style holds both themes' colours as `--diff-view-light:…;--diff-view-dark:…`.
    const pick = new RegExp(`--diff-view-${isDark ? "dark" : "light"}:([^;\\s]+)`);
    highlightCode(
      code,
      tree,
      getCssVarHighlighter(),
      (text, style) => {
        const color = style.match(pick)?.[1];
        lines[lines.length - 1] += color
          ? `<span style="color:${color}">${escapeHtml(text)}</span>`
          : escapeHtml(text);
      },
      () => lines.push(""),
    );
  } else {
    lines.splice(0, 1, ...code.split("\n").map(escapeHtml));
  }
  const background = isDark ? "#24292e" : "#fff";
  const body = lines.map((line) => `<span class="line">${line}</span>`).join("\n");
  return `<pre style="background-color:${background};color:${githubPalette(isDark).foreground}" tabindex="0"><code>${body}</code></pre>`;
}
