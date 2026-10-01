# Website (`website/`)

Notes for working in this directory. The repository-wide rules are in the root `AGENTS.md`.

## The website's home page video

The video at the top of the docs home page (`website/.vitepress/theme/HomeVideo.vue`) is not in
git. It is the `maestro.mp4` asset of the `website-media` release, and `bun run media` in
`website/` downloads it into `website/public/`, which `.gitignore` excludes. The Website workflow
runs that step before building, so Pages serves the file from the site as `video/mp4`. Do not
point `<video src>` at the release URL instead: GitHub serves release assets as
`application/octet-stream`, which Safari will not play.

To replace the video, upload the new file and rebuild the site. Re-uploading an asset does not
trigger the workflow, so start it by hand:

```bash
gh release upload website-media maestro.mp4 -R emdgroup/maestro --clobber
gh workflow run website.yml -R emdgroup/maestro
```

Its first and last frames are the same poster, `website/public/maestro-poster.webp`, so replace
that too if the opening frame changes, and update the `0:57` on the play button if the length
does. The release is not marked Latest and must stay that way: the download page links
`releases/latest/download/`.
