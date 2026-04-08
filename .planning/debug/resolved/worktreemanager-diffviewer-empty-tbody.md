---
status: resolved
trigger: "DiffViewer renders a table with empty tbody — the diff body shows nothing even though the per-file header renders correctly with file name, status, and stats."
created: 2026-04-01T00:00:00Z
updated: 2026-04-01T00:02:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED and FIXED
test: build passes; fix is in parseDiffString — hunks[] elements now include the --- / +++ header lines so the library's internal DiffParser can process them
expecting: diff body renders lines correctly
next_action: human verification

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Clicking a file in the WorktreeManager file list panel should show its diff content in the right-side DiffViewer.
actual: The DiffViewer renders its outer table structure (visible via "git-diff-view" data-component) but tbody is empty — no diff lines appear.
errors: No JS errors reported. The per-file header bar (showing fileName, status, +/- stats) renders correctly, so selectedFile is resolved and has data. Only the diff body content is missing.
reproduction: Open Worktrees tab, select a worktree with uncommitted changes, click a file in the left panel — header shows correctly but diff body is blank.
started: Introduced in phase 36-02 (commit f5be6e7 / 0a56c54) which redesigned WorktreeManager to pass selectedFile to DiffViewer instead of the full raw diff string.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: prop name mismatch (wrong prop name `diffFile` vs `data` on DiffViewer)
  evidence: DiffViewer already uses `data={diffFile}` — the data prop was always the correct prop and has been used since inception
  timestamp: 2026-04-01T00:01:00Z

- hypothesis: DiffViewer passes a plain object as the library's `diffFile` prop (class instance required)
  evidence: DiffViewer uses `data` prop not `diffFile` prop — this is a red herring
  timestamp: 2026-04-01T00:01:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-04-01T00:01:00Z
  checked: node_modules/@git-diff-view/core/dist/cjs/index.development.js — _DiffFile_doDiff function
  found: `this._diffList.map((s) => parseInstance.parse(s))` — each element of the hunks[] array is passed independently to the DiffParser.parse() method
  implication: Each hunks[] element must be a complete diff string that DiffParser can process independently

- timestamp: 2026-04-01T00:01:00Z
  checked: node_modules/@git-diff-view/core/src/parse/diff-parse.ts — parseDiffHeader() and parse()
  found: parseDiffHeader() scans for `---` and `+++` lines before looking for `@@`. If `+++` is not found, returns null and parse() returns empty IRawDiff with hunks:[]
  implication: Each element of hunks[] must include `--- a/file\n+++ b/file\n` header lines or DiffParser produces no hunks

- timestamp: 2026-04-01T00:02:00Z
  checked: src/utils/helpers/diff-utils.ts — parseDiffString original implementation
  found: parseDiffString built currentHunks as an array of individual line strings (one string per line). So hunks[] had N elements each being a single line like "@@ -1,3 +1,4 @@" or "+new line". The library called parse("@@ -1,3 +1,4 @@") which found no --- / +++ → returned empty → no tbody content.
  implication: This is the root cause. parseDiffString must produce hunks:[ fullFileString ] where fullFileString contains --- / +++ headers + all @@ blocks joined with \n

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: parseDiffString in diff-utils.ts built the `hunks` array as individual line strings (one element per line). The @git-diff-view/react library's `data.hunks` is `string[]` where each element is passed to DiffParser.parse(). That parser requires `--- a/file` / `+++ b/file` header lines before it recognises any `@@` hunk content. With individual line strings as input, every parse() call returned an empty IRawDiff (no hunks found) → DiffFile instance had no diff lines → empty tbody.
fix: Rewrote parseDiffString to collect the `--- a/file`, `+++ b/file`, `@@`, and content lines per file and join them into a single multi-line string. Each DiffFileWithName now has `hunks: [fullFileString]` — one element containing the complete per-file diff. Also updated computeFileStats to split that joined string into lines before counting insertions/deletions.
verification: pnpm build passes cleanly
files_changed: [src/utils/helpers/diff-utils.ts]
