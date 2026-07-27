---
name: Explore Codebase
description: Navigate and understand codebase structure using the knowledge graph
---

## Explore Codebase

Use the `codegraph_explore` MCP tool to explore and understand the codebase. It
is the only graph tool exposed — it returns the verbatim source of the matching
symbols, grouped by file, plus the call paths between them.

### Steps

1. Call `codegraph_explore` with the symbols, files, or question you are
   starting from. A bag of names works as well as a sentence.
2. Read the returned source and call paths. **Do not re-open those files** —
   the source shown is Read-equivalent.
3. If the answer spans further than what came back, call again naming the
   symbols at the edge of what you learned, or raise `maxFiles` (default 12)
   when surveying a broad area.
4. Drop to Grep/Glob/Read for anything the graph does not carry: config,
   markdown, generated files, assets, and unresolved references.

### Tips

- Name the symbols spanning a flow to trace it end to end
  (e.g. `"execute_task spawn_pty stream_output"`).
- The graph covers the frontend and all three Rust crates from the repo root,
  so `projectPath` is not needed.
- Rust resolution is weaker than TS/TSX here. Confirm a negative result with
  Grep before concluding nothing calls a function.
- If a response flags files with pending edits, read those directly.
