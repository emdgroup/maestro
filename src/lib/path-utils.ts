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
