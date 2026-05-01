/**
 * Custom shiki-based DiffHighlighter for @git-diff-view/react.
 *
 * Uses @shikijs/core (no bundled languages) + explicit per-language imports
 * so Vite only bundles grammars we actually use — instead of the 350+ that
 * `@git-diff-view/shiki` pulls in via `export * from 'shiki'`.
 */
import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { processAST } from "@git-diff-view/core";

// ── lazy language loaders ────────────────────────────────────────────────────
// Dynamic imports so each grammar becomes a separate lazy chunk (37 total).
// Vite will only include these 37, not all 350+ from shiki's bundle-full.
const LANGS = [
  () => import("@shikijs/langs/typescript"),
  () => import("@shikijs/langs/tsx"),
  () => import("@shikijs/langs/javascript"),
  () => import("@shikijs/langs/jsx"),
  () => import("@shikijs/langs/html"),
  () => import("@shikijs/langs/css"),
  () => import("@shikijs/langs/scss"),
  () => import("@shikijs/langs/json"),
  () => import("@shikijs/langs/yaml"),
  () => import("@shikijs/langs/xml"),
  () => import("@shikijs/langs/rust"),
  () => import("@shikijs/langs/go"),
  () => import("@shikijs/langs/c"),
  () => import("@shikijs/langs/cpp"),
  () => import("@shikijs/langs/java"),
  () => import("@shikijs/langs/csharp"),
  () => import("@shikijs/langs/kotlin"),
  () => import("@shikijs/langs/swift"),
  () => import("@shikijs/langs/scala"),
  () => import("@shikijs/langs/dart"),
  () => import("@shikijs/langs/zig"),
  () => import("@shikijs/langs/python"),
  () => import("@shikijs/langs/ruby"),
  () => import("@shikijs/langs/php"),
  () => import("@shikijs/langs/lua"),
  () => import("@shikijs/langs/bash"),
  () => import("@shikijs/langs/powershell"),
  () => import("@shikijs/langs/markdown"),
  () => import("@shikijs/langs/sql"),
  () => import("@shikijs/langs/graphql"),
  () => import("@shikijs/langs/toml"),
  () => import("@shikijs/langs/vue"),
  () => import("@shikijs/langs/svelte"),
  () => import("@shikijs/langs/dockerfile"),
  () => import("@shikijs/langs/terraform"),
  () => import("@shikijs/langs/makefile"),
  () => import("@shikijs/langs/groovy"),
  () => import("@shikijs/langs/diff"),
];

// ── singleton ────────────────────────────────────────────────────────────────
let _highlighterPromise: Promise<Awaited<ReturnType<typeof buildHighlighter>>> | null = null;

async function buildHighlighter() {
  const shiki = await createHighlighterCore({
    themes: [
      () => import("@shikijs/themes/github-light"),
      () => import("@shikijs/themes/github-dark"),
    ],
    langs: LANGS,
    engine: createJavaScriptRegexEngine(),
  });

  let _maxLine = 2000;
  const _ignoreList: (string | RegExp)[] = [];

  return {
    name: "shiki" as const,
    type: "class" as const,

    get maxLineToIgnoreSyntax() { return _maxLine; },
    setMaxLineToIgnoreSyntax(v: number) { _maxLine = v; },

    get ignoreSyntaxHighlightList() { return _ignoreList; },
    setIgnoreSyntaxHighlightList(v: (string | RegExp)[]) {
      _ignoreList.length = 0;
      _ignoreList.push(...v);
    },

    getAST(raw: string, fileName?: string, lang?: string) {
      if (fileName && _ignoreList.some((p) => p instanceof RegExp ? p.test(fileName) : fileName === p)) {
        return undefined;
      }
      try {
        return shiki.codeToHast(raw, {
          lang: lang ?? "text",
          themes: { dark: "github-dark", light: "github-light" },
          cssVariablePrefix: "--diff-view-",
          defaultColor: false,
          mergeWhitespaces: false,
        });
      } catch {
        return undefined;
      }
    },

    processAST,

    hasRegisteredCurrentLang(lang: string) {
      return shiki.getLanguage(lang) !== undefined;
    },

    getHighlighterEngine() {
      return shiki;
    },
  };
}

export type DiffHighlighterInstance = Awaited<ReturnType<typeof buildHighlighter>>;

export function getDiffHighlighter() {
  if (!_highlighterPromise) {
    _highlighterPromise = buildHighlighter();
  }
  return _highlighterPromise;
}
