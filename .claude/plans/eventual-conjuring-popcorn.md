# Fix: Drag-Drop File Attachment in TaskDetailScreen

## Context

Phase 62 UAT found file picker works but drag-drop doesn't. Root cause: HTML5 `dataTransfer.files` in Tauri WebView provides File objects with no `.path` property — only name/size metadata. The current drop handler falls back to `file.name` as `filePath`, which is just a filename, not a real FS path. Backend `add_task_attachment` receives a bogus path and the file can't be located on disk.

No fix needed for file picker (uses `@tauri-apps/plugin-dialog`'s `open()` which returns real paths).

## Solution

Replace HTML5 drop handler with Tauri's `getCurrentWebview().onFileDropEvent()` listener from `@tauri-apps/api/webview`. This fires with the actual OS file paths when files are dropped onto the window. Use the dropzone div only for visual feedback (`isDragOver` state); file processing moves to the Tauri event listener.

## Critical Files

- `src/components/task/TaskDetailScreen.tsx` (lines ~310-330, ~533-550)

## Implementation Plan

### 1. Swap drop handler

Remove the `handleDrop` function and the `onDrop` prop from the dropzone div.

Keep `onDragOver` / `onDragLeave` for visual feedback — these still fire before the Tauri event and are reliable for `isDragOver` state.

### 2. Add Tauri file drop listener via useEffect

```typescript
import { getCurrentWebview } from "@tauri-apps/api/webview";

useEffect(() => {
  if (!isEditable) return;

  const unlisten = getCurrentWebview().onFileDropEvent((event) => {
    if (event.payload.type === "drop" && task) {
      setIsDragOver(false);
      for (const filePath of event.payload.paths) {
        const filename = filePath.split(/[/\\]/).pop() ?? filePath;
        addAttachment.mutate({
          taskId: task.id,
          filename,
          filePath,
          fileSize: 0,
        });
      }
    }
    if (event.payload.type === "cancel") {
      setIsDragOver(false);
    }
  });

  return () => { unlisten.then((fn) => fn()); };
}, [isEditable, task?.id]);
```

**Notes:**
- `onFileDropEvent` returns `Promise<UnlistenFn>` — cleanup via `.then(fn => fn())` in effect return
- `fileSize: 0` acceptable — same as file picker path (size is stored as metadata only, not used by backend to read content)
- Guard `isEditable` so listener only active when task is Backlog (matches existing file picker guard)

### 3. Keep dropzone div but remove onDrop

The dropzone div keeps visual feedback (`isDragOver` border highlight + "drop files here" text). Remove `onDrop={handleDrop}` from its props.

### 4. Verify `@tauri-apps/api` is already a dep

`@tauri-apps/api` already in package.json. `getCurrentWebview` is from `@tauri-apps/api/webview` (Tauri 2 API).

## Verification

1. `pnpm build` passes (TypeScript check)
2. In `pnpm tauri:dev`: open task detail (Backlog status), drag a file from OS file manager onto the dropzone — file should appear in attachment list
3. Confirm file picker still works
4. Confirm drag-drop disabled on non-Backlog tasks (listener not registered when `!isEditable`)
