# Plan: Paste Image Support in ComposeBar

## Context

ComposeBar already supports file attachments via paperclip button (native file picker). Pasting an image from clipboard should work identically — appear as attachment pill, get sent with message. Currently no `onPaste` handler exists. The existing pipeline requires a `localAbsPath` (file on disk), but clipboard paste yields in-memory blob data. Bridge needed.

## Approach

1. Add small Rust IPC command that writes base64 image bytes to a temp file, returns path
2. Add `onPaste` handler in ComposeBar that extracts image from clipboard, calls IPC, creates `ExternalAttachment`
3. Existing `prepare_external_attachments` flow handles the rest unchanged

## Changes

### 1. Rust: Add `save_clipboard_image` IPC command

**File**: `src-tauri/src/ipc/acp_handlers.rs` (after `prepare_external_attachments`, ~line 1904)

```rust
#[tauri::command]
#[specta::specta]
pub async fn save_clipboard_image(
    base64_data: String,
    mime_type: String,
) -> Result<String, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64 data: {e}"))?;

    if bytes.is_empty() {
        return Err("Empty image data".to_string());
    }

    let ext = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random_suffix: u32 = rand::random();

    let tmp_path = std::env::temp_dir()
        .join(format!("maestro-clipboard-{timestamp}-{random_suffix}.{ext}"));

    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    Ok(tmp_path.to_string_lossy().to_string())
}
```

### 2. Register command in `lib.rs`

**File**: `src-tauri/src/lib.rs` line 114

Add after `prepare_external_attachments`:
```rust
crate::ipc::save_clipboard_image,
```

### 3. Regenerate bindings

```bash
pnpm tauri:gen
```

### 4. Frontend: Add `handlePaste` to ComposeBar

**File**: `src/components/execution/activity/ComposeBar.tsx`

Add callback near `handleAttach` (~line 184):

```typescript
const handlePaste = useCallback(
  async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!promptCapabilities?.image || !logId) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === "file" && items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length === 0) return;
    e.preventDefault();

    for (const file of imageFiles) {
      const mimeType = file.type || "image/png";
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Data = btoa(binary);

      const tempPath = await api.saveClipboardImage(base64Data, mimeType);

      const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const existingPasted = attachments.filter((a) =>
        a.displayName.startsWith("Pasted image"),
      ).length;
      const displayName =
        existingPasted === 0
          ? `Pasted image.${ext}`
          : `Pasted image (${existingPasted + 1}).${ext}`;

      setAttachments((prev) => [
        ...prev,
        { id: `${Date.now()}-${Math.random()}`, displayName, localAbsPath: tempPath, isImage: true },
      ]);
    }
  },
  [promptCapabilities, logId, attachments],
);
```

Wire to textarea — add `onPaste={handlePaste}` prop (line ~622).

## Edge Cases Handled

- **Text paste**: No image items found → returns without `preventDefault()` → normal text paste works
- **Image capability disabled**: Early return if `!promptCapabilities?.image`
- **No session**: Early return if `!logId`
- **Large images**: Existing 10MB reject / 5MB auto-scale in `prepare_external_attachments` applies
- **Multiple images in one paste**: Loop handles all items

## Verification

1. `cargo check` in `src-tauri/` — confirms Rust compiles
2. `pnpm tauri:gen` — confirms bindings generate
3. `pnpm lint` — confirms no frontend lint errors
4. Manual test: `pnpm tauri:dev`, take screenshot, paste in composer → pill appears → send → agent receives image
5. Manual test: paste plain text → still works as normal text input

## Files Modified

1. `src-tauri/src/ipc/acp_handlers.rs` — new `save_clipboard_image` command
2. `src-tauri/src/lib.rs` — register command (~line 114)
3. `src/types/bindings.ts` — auto-generated
4. `src/components/execution/activity/ComposeBar.tsx` — `handlePaste` + `onPaste` prop
