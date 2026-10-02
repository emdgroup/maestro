/**
 * Stands in for `lowlight`, aliased in vite.config.ts.
 *
 * `@git-diff-view/lowlight` calls `createLowlight(all)` at module scope, which bundles every
 * highlight.js grammar (~900 kB minified) into the chunk every markdown view loads. Diffs are
 * highlighted by shiki (`shiki-highlighter.ts`); lowlight is only the fallback `@git-diff-view/core`
 * reaches for when shiki has not registered a file's language. This one registers nothing and
 * returns no tree, so those files render as plain text instead.
 */

export const all = {};
export const common = {};

export function createLowlight() {
  return {
    register() {},
    registered: () => false,
    listLanguages: (): string[] => [],
    highlight: () => undefined,
    highlightAuto: () => undefined,
  };
}
