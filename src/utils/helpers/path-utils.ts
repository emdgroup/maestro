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
 * Last segment of a path, whichever separator it uses.
 *
 * @example
 * basename('src\\components\\App.tsx') // returns 'App.tsx'
 */
export function basename(path: string): string {
  const parts = toPosixPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}
