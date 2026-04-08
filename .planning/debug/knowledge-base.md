# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## worktreemanager-diffviewer-empty-tbody — @git-diff-view hunks[] elements must be complete per-file diff strings, not individual lines
- **Date:** 2026-04-01
- **Error patterns:** DiffViewer, empty tbody, diff body blank, parseDiffString, hunks, @git-diff-view, DiffFile, DiffParser
- **Root cause:** parseDiffString in diff-utils.ts built the `hunks` array as individual line strings (one element per line). The @git-diff-view/react library's `data.hunks` is `string[]` where each element is passed to DiffParser.parse(). That parser requires `--- a/file` / `+++ b/file` header lines before it recognises any `@@` hunk content. With individual line strings as input, every parse() call returned an empty IRawDiff → DiffFile instance had no diff lines → empty tbody.
- **Fix:** Rewrote parseDiffString to collect `--- a/file`, `+++ b/file`, `@@`, and content lines per file and join them into a single multi-line string. Each DiffFileWithName now has `hunks: [fullFileString]` — one element containing the complete per-file diff. Also updated computeFileStats to split that joined string into lines before counting insertions/deletions.
- **Files changed:** src/utils/helpers/diff-utils.ts
---
