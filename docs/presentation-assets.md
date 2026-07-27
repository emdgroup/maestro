# README presentation assets

This guide describes the product captures used by the README. There are no mock screenshots here: every published image is captured from a working Maestro build.

## Asset layout

```text
docs/assets/
├── maestro-workflow.webp   # animated product demo
├── kanban-board.webp
├── live-execution.webp
├── diff-review.webp
└── issue-import.webp       # not captured yet
```

Assets live under `docs/` rather than `public/`, because `public/` is Vite's
`publicDir` — anything placed there is copied into the app bundle and ships
inside every installer.

`issue-import.webp` is the one entry that is still missing: it needs a
configured GitHub or Jira connection, which the capture fixture deliberately
does not have. The README carries a comment where that image belongs. Do not
enable an image reference before its asset exists.

## Capture fixture

Use a disposable public repository with small, realistic tasks. Seed it with enough activity to demonstrate the product without exposing internal source code, credentials, usernames, hostnames, issue URLs, or model account details.

The current set was captured from `acme-notes`, a throwaway TypeScript CLI at
`C:\Users\Public\maestro-demo` — a path with no user name in it, since the
project name and branch names are visible in most views. Real agents ran real
tasks against it, so every diff and activity line in the images is genuine.

Keep the same fixture, window size, theme, and zoom level across all captures:

- Capture the app window at 1600 x 1000 or a similar 16:10 ratio.
- Use the default app zoom and a single theme throughout the set.
- Keep text large enough to read when the README renders the image at 960 px wide.
- Prefer WebP for static images; crop to the app window without decorative device frames.
- Show realistic content, but keep task titles and diffs short enough to scan.
- Hide notifications, system panels, mouse tooltips, and unrelated applications.
- Keep the update banner and the Settings view out of frame — both date the capture.

## How the current set was captured

The webview is Chromium, so it can be driven and captured over the DevTools
protocol without a screen recorder, and without the mouse pointer or window
chrome landing in the frame. Launch the app with a debugging port:

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" ./maestro   # Windows (WebView2)
```

Then drive `Runtime.evaluate`, `Input.dispatchMouseEvent` and
`Page.captureScreenshot` against the page target at
`http://127.0.0.1:9222/json/list`. `Emulation.setDeviceMetricsOverride` fixes
the capture size independently of the real window, and a
`Page.captureScreenshot` loop supplies the frames for the demo animation,
which `ffmpeg` assembles:

```bash
ffmpeg -framerate 8 -i frame-%04d.png -vf "scale=960:-2:flags=lanczos" -loop 0 maestro-workflow.webp
```

Two things to know before repeating this. Input events are dispatched at
viewport coordinates, so scroll the target into view and recompute its
rectangle immediately before clicking — a stale rectangle silently clicks
whatever moved into that spot. And a task only runs if it resolves an agent:
either set the project default agent and restart, or set `agent_id` on the
task itself.

## Demo sequence

Record one continuous 25-35 second workflow for `maestro-workflow.webp`:

1. Start on a populated Kanban board.
2. Run a queued task and show it enter the active state in an isolated worktree.
3. Show meaningful agent activity without long idle periods.
4. Open the resulting diff at hunk level.
5. End on the review state before committing, so the recording does not imply unreviewed changes are shipped automatically.

Edit out waiting time before export. Keep the final animation under 3 MB, target 8-15 frames per second, and make the first frame useful as a static preview. If text becomes unreadable at that size, publish a shorter recording rather than reducing resolution further.

## Screenshot shot list

| File                  | Required scene                                                                 | What the image should prove                                                               |
| --------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `kanban-board.webp`   | A board with tasks in several columns and at least two active tasks            | Multiple tasks can progress independently and the overall workload remains understandable |
| `live-execution.webp` | An active task with structured activity, tool calls, and changed files visible | Agent work is observable while it runs                                                    |
| `diff-review.webp`    | A concise source diff with hunk-level controls visible                         | Users can inspect and selectively stage generated changes                                 |
| `issue-import.webp`   | A populated GitHub Issues or Jira import view with one issue selected          | Existing tracker work can become a Maestro task                                           |

Avoid capturing empty states, setup dialogs, loading indicators, error banners, or controls hidden by open menus unless one is the subject of the image.

## Publication checklist

Before enabling any README image:

1. Open the exported file and verify that text is legible at 960 px width.
2. Check every visible path, branch, remote, issue, terminal line, and diff for sensitive data.
3. Confirm the capture matches the current released interface and the adjacent README claim.
4. Optimize the file without scaling it below the documented capture size.
5. Add the asset under `docs/assets/` and point the README markup at it.
6. Preview the README locally or on GitHub and verify the image has useful alt text and no broken link.

Refresh a capture when the surrounding interface changes materially. A smaller honest set is preferable to stale screenshots.
