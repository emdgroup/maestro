# README presentation assets

This guide defines the product captures used by the README. It deliberately does not include mock screenshots: every published image must be captured from a working Maestro build.

## Asset layout

```text
public/
├── demo/
│   └── maestro-workflow.webp
└── screenshots/
    ├── kanban-board.webp
    ├── live-execution.webp
    ├── diff-review.webp
    └── issue-import.webp
```

The README already contains commented image markup for these paths. Add a verified capture at the matching path, then remove the surrounding HTML comment to publish it. Do not enable an image reference before its asset exists.

## Capture fixture

Use a disposable public repository with small, realistic tasks. Seed it with enough activity to demonstrate the product without exposing internal source code, credentials, usernames, hostnames, issue URLs, or model account details.

Keep the same fixture, window size, theme, and zoom level across all captures:

- Capture the app window at 1600 x 1000 or a similar 16:10 ratio.
- Use the default app zoom and a single theme throughout the set.
- Keep text large enough to read when the README renders the image at 960 px wide.
- Prefer WebP for static images; crop to the app window without decorative device frames.
- Show realistic content, but keep task titles and diffs short enough to scan.
- Hide notifications, system panels, mouse tooltips, and unrelated applications.

## Demo sequence

Record one continuous 25-35 second workflow for `public/demo/maestro-workflow.webp`:

1. Start on a populated Kanban board.
2. Open a prepared task with concise instructions.
3. Run the task and show it enter the active state in an isolated worktree.
4. Show meaningful terminal and activity updates without long idle periods.
5. Open the resulting diff and stage one hunk.
6. End on the review state before committing, so the recording does not imply unreviewed changes are shipped automatically.

Use a prepared agent result or edit out waiting time before export. Keep the final animation under 10 MB where practical, target 12-15 frames per second, and make the first frame useful as a static preview. If text becomes unreadable at that size, publish a shorter recording rather than reducing resolution further.

## Screenshot shot list

| File                  | Required scene                                                                      | What the image should prove                                                               |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kanban-board.webp`   | A board with tasks in several columns and at least two active tasks                 | Multiple tasks can progress independently and the overall workload remains understandable |
| `live-execution.webp` | An active task with terminal output, structured activity, and changed files visible | Agent work is observable while it runs                                                    |
| `diff-review.webp`    | A concise source diff with hunk-level controls visible                              | Users can inspect and selectively stage generated changes                                 |
| `issue-import.webp`   | A populated GitHub Issues or Jira import view with one issue selected               | Existing tracker work can become a Maestro task                                           |

Avoid capturing empty states, setup dialogs, loading indicators, error banners, or controls hidden by open menus unless one is the subject of the image.

## Publication checklist

Before enabling any README image:

1. Open the exported file and verify that text is legible at 960 px width.
2. Check every visible path, branch, remote, issue, terminal line, and diff for sensitive data.
3. Confirm the capture matches the current released interface and the adjacent README claim.
4. Optimize the file without scaling it below the documented capture size.
5. Add the asset at the exact path above and uncomment only its matching README markup.
6. Preview the README locally or on GitHub and verify the image has useful alt text and no broken link.

Refresh a capture when the surrounding interface changes materially. A smaller honest set is preferable to stale screenshots.
