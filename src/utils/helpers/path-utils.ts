/**
 * Extract the folder name from a file system path.
 *
 * @param path - Full file system path
 * @returns The last folder/file name in the path
 *
 * @example
 * getFolderName('/home/user/projects/my-app') // returns 'my-app'
 * getFolderName('/path/to/') // returns 'to'
 * getFolderName('/') // returns '/'
 */
export function getFolderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Windows paths reach the UI with backslashes — from tool calls, from the Rust
 * side, from the OS dialogs — while everything that compares or joins them here
 * assumes "/".
 */
export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Whether a path is already absolute, and so must not be joined onto a root.
 *
 * Covers both shapes the UI sees at once: posix (`/home/…`, and UNC `\\wsl$\…`
 * once normalised) and Windows drive letters (`C:\…`). A local connection is
 * whichever the host is, a remote one is posix, and the same panels render both.
 */
export function isAbsolutePath(path: string): boolean {
  return /^(\/|[A-Za-z]:\/)/.test(toPosixPath(path));
}

/**
 * Turn a `file://` URI from an agent message into a path the file panels accept.
 *
 * Two spellings arrive: RFC 8089's empty authority (`file:///C:/…`, what an agent
 * writes) and the authority-less one `ComposeBar` emits by pasting the session cwd
 * straight after `file://` (`file://C:/…`, `file:///home/…` once the posix cwd's
 * own leading slash lands there). Both must yield the same path, so the slash is
 * only dropped in front of a drive letter — a posix root has to keep it, and a UNC
 * root (`file://\\wsl$\…`) keeps both of its own.
 *
 * @example
 * fileUriToPath('file:///C:/Users/me/a.png')  // 'C:/Users/me/a.png'
 * fileUriToPath('file:///home/me/a.png')      // '/home/me/a.png'
 */
export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return toPosixPath(uri);
  const path = toPosixPath(uri.slice(7)).replace(/^\/(?=[A-Za-z]:)/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    // A literal "%" in a filename is not an escape; keep the path as it came.
    return path;
  }
}

/**
 * Last segment of a path, whichever separator it uses.
 *
 * @example
 * basename('src\\components\\App.tsx') // returns 'App.tsx'
 */
export function basename(path: string): string {
  const parts = toPosixPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}
