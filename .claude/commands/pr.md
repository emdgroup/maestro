---
description: Commit if needed, open a PR, then watch CI and fix what breaks
argument-hint: "[target-branch]"
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

Ship the current work as a pull request and stay with it until CI is green.

Target branch: `$ARGUMENTS` if given, otherwise the repo default branch
(`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).

## 1. Get the work onto a branch

- `git status --short` and `git log --oneline @{u}.. 2>/dev/null` — figure out whether
  there is anything uncommitted, anything unpushed, or an existing PR
  (`gh pr view --json number,url,headRefName`).
- If HEAD is the target branch, create a branch first — never push work straight to it.
  Name it after what the change does (`fix-review-tab-diff`, not `patch-1`).
- Commit only what belongs to this change. Read the diff before writing the message; a
  message derived from filenames instead of the actual hunks is worse than no message.
  Follow the repo's existing commit style (check `git log --oneline -15`).
- If everything is already committed and pushed and a PR exists, skip to step 3 — this
  command is also how you resume babysitting a PR.

## 2. Run CI locally before pushing

A failed CI run costs minutes of waiting; the same check locally costs seconds. Run the
checks that match what the change touched — frontend edits do not need a `cargo clippy`
run, and vice versa. Read `.github/workflows/ci.yml` for the authoritative list.

For this repo that is roughly:

| Touched            | Run                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| `src/`, config     | `bun run lint` · `bun run format` · `bun run build` · `bun run test --run`            |
| Rust crates        | `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test` for the crate  |

Fix what fails, then push (`git push -u origin HEAD`).

One trap worth knowing: any `cargo test -p maestro --lib` run rewrites
`src/types/bindings.ts` unformatted, so it will show up dirty afterwards. Run
`bun run format:fix` and check whether the exported names actually changed before
assuming the bindings were stale.

## 3. Open the PR

`gh pr create --base <target> --fill` is a starting point, not the answer — write the body
yourself so it says why the change exists, not just what changed.

The repo's PR rules (AGENTS.md) are enforced by reviewers, so get them right the first time:

- Imperative, capitalized title, no `feat:`/`fix:` prefix, no trailing period.
- Optional crate-name prefix when one crate is clearly the scope: `git_ui: Add history view`.
- A `Release Notes:` section last in the body, blank line after the heading, one bullet:
  `- Added ...` / `- Fixed ...` / `- Improved ...`, or `- N/A` for docs-only changes.
- End the body with the Claude Code attribution line.

Print the PR URL as soon as it exists — the user may want to look at it while CI runs.

## 4. Watch CI

```bash
gh pr checks --watch --fail-fast
```

That blocks until the checks settle. If it exits non-zero, get the actual failure rather
than guessing from the job name:

```bash
gh run view <run-id> --log-failed
```

## 5. Fix, or ask

Diagnose before editing. The job name tells you which command failed; the log tells you
why. Read enough of it to name the root cause in one sentence — if you cannot, you are
about to guess, and a guessed CI fix burns another full run to disprove.

Fix it yourself when the failure is mechanical and the correct output is not a judgment
call: formatting, lint rules, a clippy suggestion, a type error, a test asserting on
something you just renamed, a missing regenerated binding. Then verify locally with the
same command CI ran, commit with a message naming the failure, push, and go back to
step 4.

Stop and ask the user when the fix requires a decision that is theirs:

- A test fails because the behaviour genuinely changed — only they know which side is right.
- The failure is in code your change did not touch, or reproduces on the target branch too
  (check before blaming yourself: `gh run list --branch <target> --limit 5`).
- The fix would mean loosening a check — deleting a test, adding an ignore, widening a lint
  allow. Silencing a check that is correctly failing is worse than a red PR, because it is
  invisible afterwards.
- Infrastructure: a timeout, a runner dying, a network flake, a missing secret. Offer to
  rerun (`gh run rerun <run-id> --failed`) once; twice is a pattern, not a flake.
- Three fix attempts have not turned it green. At that point your model of the failure is
  wrong, and more attempts just add commits — say what you tried, what you believe is
  happening, and what you would need to know.

When CI is green, say so plainly with the PR URL and a one-line summary of what CI ran and
anything you had to fix along the way. Do not report green from a partial run — `gh pr
checks` exiting on a still-pending check is not a pass.
