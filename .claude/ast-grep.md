# ast-grep reference

## Language flags

| File type | Flag |
|-----------|------|
| `.tsx` React components | `--lang tsx` |
| `.ts` non-JSX files | `--lang typescript` |
| `.rs` Rust files | `--lang rust` |

## Working patterns

```bash
# Find all useState calls in React components
ast-grep --pattern 'useState($$$)' --lang tsx src/

# Find all for loops in Rust
ast-grep --pattern 'for $VAR in $ITER { $$$BODY }' --lang rust maestro-server/src/

# Find method calls in Rust
ast-grep --pattern '$OBJ.map_err($$$)' --lang rust src-tauri/src/
```

## Known quirks

**Language / file extension:**
- **TSX not TypeScript for component files.** `.tsx` files need `--lang tsx`; `--lang typescript` only scans `.ts` files. Wrong lang = zero results, no error.
- **`--lang typescript` scans `.ts` only; `--lang tsx` scans `.tsx` only.** To search both, run two commands.

**Rust function declarations:**
- **`fn $NAME($$$)` fails with multi-line params.** Pattern requires params on one line. Workaround: search call-sites (`$EXPR.method($$$)`) or inner patterns (loops, `if let`, `match`) instead.
- **`impl $TRAIT for $TYPE` works**, but only when the impl body fits (multi-line bodies match fine via `$$$BODY`).

**TypeScript/TSX patterns that work reliably:**
- `import $NAME from "$MOD"` — default imports
- `import { $$$NAMES } from "$MOD"` — named imports
- `function $NAME($$$PARAMS) { $$$BODY }` — function declarations (including destructured params like `{ $$$PARAMS }: $TYPE`)
- `const { $$$FIELDS } = $EXPR` — object destructuring (single-line and multi-line both match)
- `const [$A, $B] = $EXPR` — array destructuring
- `await $EXPR` — await expressions
- `type $NAME = $TYPE` — type aliases
- `useState($$$)`, `useCallback($CB, [$$$DEPS])` — hook calls

**TypeScript/TSX patterns that do NOT work:**
- `const $NAME = ($$$PARAMS) => { $$$BODY }` — const arrow functions fail to match (even when they exist in the file)
- `useQuery({ $$$OPTS })` — object literal arg with space after `{` doesn't match; `useQuery($$$)` works fine
- `interface $NAME { $$$FIELDS }` — interfaces only match in `.ts` files, not `.tsx`; use `--lang typescript` on the right file

**General:**
- **Exit code 1 = no matches**, not an error. Don't treat non-zero exit as failure.
- **Pattern must match the full AST node.** Partial or structural mismatches fail silently. Use `--debug-query=pattern` to inspect how ast-grep parses your pattern.
- **Directory scans work** — pass a directory path, not just a file; ast-grep recurses.
