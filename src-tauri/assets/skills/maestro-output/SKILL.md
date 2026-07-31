---
name: maestro-output
description: Rich output formats for the Maestro desktop app, which renders live canvas dashboards, Mermaid diagrams, LaTeX math, SVG and SMILES inline. Use this whenever you are about to present data, metrics, comparisons, test or build results, a status overview, a report, or any answer covering more than a handful of items — Maestro can show it instead of describing it, so reach for these formats even when the user never mentions charts, dashboards or diagrams. Applies only when the environment variable MAESTRO_SESSION is set; if it is not, you are in a plain terminal where none of this renders, and this skill does not apply.
---

# Rendering output in Maestro

## First: are you actually in Maestro?

This skill is installed globally, so it is in context for every session of this agent on this
machine — including the ones the user starts from a plain terminal that has nothing to do with
Maestro. There, a canvas fence is unparsed JSON on the screen, Mermaid is a wall of arrow syntax,
and `maestro-server` is not on `PATH`.

Maestro sets `MAESTRO_SESSION=1` on every agent it spawns. Check it once, the first time you are
about to use one of these formats — not at the start of every session, since most sessions never
need it:

```
echo "${MAESTRO_SESSION:-unset}"
```

If it prints `unset`, stop here and answer in ordinary markdown. Everything below assumes you are
inside Maestro.

## Choosing a format

Maestro is a desktop app, not a terminal. Someone who asks "what's failing in CI?" in a window
with a rendering surface expects to _see_ the answer, not read a paragraph reconstructing it. The
default of dumping a bulleted list is a habit from text-only environments, and here it throws away
the medium.

So the question to ask before answering is not "did they ask for a chart?" — they almost never
will — but "does this answer have shape?" Numbers over time, parts of a whole, items with
attributes, a process with branches, a comparison: all of that has shape, and shape is what these
formats are for.

| What the answer is                                                   | Reach for                        |
| -------------------------------------------------------------------- | -------------------------------- |
| Several things with attributes you'd compare — services, runs, files | canvas `DataTable`               |
| Numbers that move — over time, across categories, as proportions     | canvas `Chart`                   |
| A mix: some totals, a table, a trend, all answering one question     | canvas dashboard (`Card`, `Row`) |
| Anything you'd otherwise render as a static picture of data          | canvas                           |
| Control flow, architecture, state machines, sequences of calls       | ` ```mermaid `                   |
| A formula, complexity bound, derivation                              | `$...$` / `$$...$$` (KaTeX)      |
| A diagram of something physical or spatial — layout, geometry        | ` ```svg `                       |
| A molecule                                                           | ` ```smiles `                    |
| A handful of rows with no live data behind them                      | GFM table (sortable columns)     |
| Code                                                                 | fenced block with a language tag |

### When plain prose is the right answer

Reaching for canvas on everything is its own failure — it is slower, it costs a validation round
trip, and a dashboard wrapped around a single number is worse than the number. Answer in ordinary
markdown when:

- the answer is one value, one sentence, or one file path;
- the user asked _why_ or _how_ rather than _what_ — explanation is prose;
- you are mid-task and reporting progress;
- you have three rows and no numbers, where a GFM table is lighter and reads the same.

The test is whether the reader would scan the answer or read it. Scanning wants structure.
Reading wants sentences.

## Canvas

Canvas surfaces are live: you create one, push data into it, and update components in place as
more data arrives, so a dashboard can fill in while tool calls are still running rather than
appearing all at once at the end.

They are emitted as ` ```maestro-canvas ` fences containing one JSON message. Maestro strips the
fence from the text stream and renders it.

Read `references/canvas.md` before writing your first fence in a session — it covers the message
protocol and its mandatory ordering, the validation step, component selection, and the failure
patterns that produce a surface stuck on skeletons. The component catalog it works from is
`references/canvas-catalog.json`, which documents every component's props.

Two things worth knowing before you get there, because they are the ones that bite:

- Every fence must be validated with `maestro-server validate-canvas` before you emit it. A fence
  with a schema error renders as a broken surface the user has to look at, and you will not see
  the error yourself — validation is the only feedback loop you have.
- Data goes in its own message _before_ the component that references it. A component pointing at
  a path with nothing behind it shows a skeleton forever.

## The other formats

These need no validation and no protocol — write the fence and Maestro renders it.

- **Mermaid** — ` ```mermaid `, all the usual diagram types (flowchart, sequence, class, state, ER, gantt).
- **LaTeX** — `$...$` inline and `$$...$$` block, KaTeX syntax.
- **SVG** — ` ```svg `, for spatial or geometric figures Mermaid cannot express.
- **SMILES** — ` ```smiles `, for chemical structures.
- **Tables and code** — GFM tables render with sortable columns; fenced code blocks are syntax
  highlighted from their language tag, so always tag them.

If the project has a `.maestro/canvas-skills.md`, read it before building a canvas — it holds
patterns specific to that codebase and overrides the general guidance here.
