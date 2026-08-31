---
name: maestro-output
description: MANDATORY output formatting for the Maestro desktop app. Invoke BEFORE writing any reply — every request, before you answer, report, summarize, compare or explain — not only when you already expect structure, since you cannot judge your answer's shape before reading this. Maestro is not a terminal: it renders canvas dashboards and real UI controls, Mermaid, LaTeX, SVG, SMILES and sortable tables inline, and flat prose throws all of that away. Assume shape until proven otherwise; "show me x", "list the y", "what's the status", "how does this work", "compare a and b" all land as a table, chart, diagram, dashboard or mock. Always invoke for a table, an inventory, items with attributes, more than three numbers, test/build/CI results, a status overview, UI, control flow, architecture, a formula, a layout, a molecule. Users never ask for a chart or a diagram, so invoke on the shape of the answer, not on their wording. Flattening shaped data into prose is the failure this skill exists to prevent.
user-invocable: false
allowed-tools: Bash(maestro-server validate-canvas*) Bash(echo *)
---

# Rendering output in Maestro

Session check — `MAESTRO_SESSION` is: !`echo "${MAESTRO_SESSION:-unset}"`

`unset` means a plain terminal, not Maestro: none of this renders and `maestro-server` is absent.
Answer in ordinary markdown and ignore the rest of this file. If the line is blank or still shows
a raw `${...}`, the check did not run — run `echo $MAESTRO_SESSION` yourself before deciding.

## Choosing a format

Ask "does this answer have shape?", not "did they ask for a chart?" — they almost never will.
Numbers over time, parts of a whole, items with attributes, a process with branches, a comparison:
that is shape, and shape is what these formats are for.

You are meant to arrive here on most turns, before you know the answer's shape. If it turns out to
have none, go straight to plain markdown — see below — and lose nothing. Once you have read this
file it stays in context, so a later turn in the same session needs no second invocation.

| What the answer is                                                     | Reach for                        |
| ---------------------------------------------------------------------- | -------------------------------- |
| Rows the user will filter or page through, or read next to a chart     | canvas `DataTable`               |
| Numbers that move — over time, across categories, as proportions       | canvas `Chart`                   |
| A mix: totals, a table and a trend answering one question together     | canvas dashboard (`Card`, `Row`) |
| A mock of UI — a control, dialog, form, a screen                       | canvas (real `Button`, `Modal`)  |
| Static tabular content — a comparison, an inventory, an attribute grid | GFM table (sortable columns)     |
| Control flow, architecture, state machines, sequences of calls         | ` ```mermaid `                   |
| A formula, complexity bound, derivation                                | `$...$` / `$$...$$` (KaTeX)      |
| A chemical equation                                                    | `\ce{...}` inside KaTeX (mhchem) |
| Something physical or spatial — layout, geometry, a UI arrangement     | ` ```svg `                       |
| A molecule                                                             | ` ```smiles `                    |
| Code                                                                   | fenced block with a language tag |

### `DataTable` or a GFM table?

This is the pair that gets confused, and row count is not what separates them — a 40-row GFM
table is fine, and a 3-row `DataTable` can be right.

Reach for canvas `DataTable` when the table is **interactive or live**: the user will filter it,
page through it, or read it alongside a `Chart` on the same surface that shares its data, or rows
keep arriving while tool calls run. That interaction is the whole reason the component exists.

Otherwise use a GFM table. It already sorts on column click, it costs no validation round trip,
and it stays readable when the user copies the answer out of Maestro.

### When plain prose is the right answer

Answer in ordinary markdown when the answer is one value or one sentence, when the user asked
_why_ or _how_, or when you are mid-task reporting progress. The test is whether the reader would
scan the answer or read it — scanning wants structure, reading wants sentences.

## Canvas

Canvas surfaces are live: create one, push data in, and update components in place as more data
arrives, so a dashboard fills in while tool calls are still running. They are emitted as
` ```maestro-canvas ` fences holding one JSON message, which Maestro strips from the text stream
and renders.

They are not only for data. The catalog has real controls — `Button`, `Modal`, `TextField`,
`CheckBox`, `ChoicePicker`, `Slider`, `DateTimeInput` — rendered as Maestro's own components in
the user's theme, so a mock of a dialog or a form is the working thing rather than a picture of
it. Never draw UI as ASCII art or box-drawing characters.

Read `references/canvas.md` before your first fence in a session — message protocol and its
mandatory ordering, validation, component selection, and the failure patterns that leave a surface
stuck on skeletons. Its component catalog is `references/canvas-catalog.json`.

Two things bite before you get there:

- **Data before component.** A component pointing at a path with nothing behind it shows a
  skeleton forever.
- **Validate every fence** with `maestro-server validate-canvas` before emitting it. You never see
  the rendered result, so this is your only signal that what you emitted is a working surface
  rather than a broken one the user is now staring at.

Keep that validation loop out of your reply: never paste the fence JSON, the command, or its
output; never announce that you are about to validate or that it passed; never narrate a retry.
The user sees a rendered surface, not the machinery. If a fence cannot be made to validate, drop
the canvas and answer in plain markdown rather than explaining the failure.

## The other formats

These need no validation and no protocol — write the fence and Maestro renders it.

- **Mermaid** — ` ```mermaid `, all the usual diagram types (flowchart, sequence, class, state, ER, gantt).
- **LaTeX** — `$...$` inline and `$$...$$` block, KaTeX syntax. `mhchem` is loaded, so `\ce{H2O}`
  and reaction arrows work inside the same delimiters.
- **SVG** — ` ```svg `, for spatial or geometric figures Mermaid cannot express. A raw `<svg>`
  element written straight into the markdown renders too. Either way it gets click-to-zoom.
- **SMILES** — ` ```smiles `, for chemical structures.
- **Tables and code** — GFM tables render with sortable columns; fenced code blocks are syntax
  highlighted from their language tag, so always tag them.

### Smaller things the renderer does

- **Task lists and strikethrough** — `- [ ]`, `- [x]`, `~~text~~`. Better than a bulleted list
  with the word "done" in it.
- **`==highlight==`** renders as `<mark>` — point at the one cell or line that matters.
- **Headings are anchored** — `[jump](#the-heading)` scrolls the panel. Useful in a long report.
- **`file://` links open in Maestro**, not a browser. Prefer one to a bare quoted path.
- **Images render inline** — `![alt](path)`, project-relative, `file://` or `data:`; proxied and
  zoomable, so a screenshot or generated PNG can go straight in.
- **A ` ```markdown ` fence renders as markdown**, nested fences and all. Use a language-tagged
  fence when you mean "show the source".
