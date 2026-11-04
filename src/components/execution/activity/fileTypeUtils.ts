import {
  File,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Image,
  type LucideIcon,
} from "lucide-react";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".tiff",
  ".bmp",
  ".ico",
  ".svg",
]);

const MIME_MAP: Record<string, string> = {
  ".rs": "text/x-rust",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rb": "text/x-ruby",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".toml": "text/x-toml",
  ".json": "application/json",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".sh": "text/x-sh",
  ".html": "text/html",
  ".css": "text/css",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
  ".pdf": "application/pdf",
};

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const EXT_TO_LANG: Record<string, string> = {
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".py": "python",
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".html": "html",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot !== -1 ? path.slice(dot).toLowerCase() : "";
}

export function mimeForExtension(path: string): string | undefined {
  return MIME_MAP[extOf(path)];
}

export function isImageExtension(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extOf(path));
}

export function langForExtension(path: string): string | undefined {
  return EXT_TO_LANG[extOf(path)];
}

export function imageMimeForExtension(path: string): string {
  return IMAGE_MIME[extOf(path)] ?? "image/png";
}

const BINARY_EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const ICON_BY_EXTENSION: Record<string, LucideIcon> = {};
for (const [icon, exts] of [
  [FileSpreadsheet, "csv tsv xlsx xls ods"],
  [
    FileCode,
    "ts tsx js jsx mjs cjs rs py go rb java c cpp h hpp cs php swift kt json yaml yml toml xml env ini conf cfg html css sql graphql",
  ],
  [FileTerminal, "sh bash zsh fish ps1 bat cmd"],
  [FileArchive, "zip tar gz 7z rar bz2 xz"],
  [FileText, "txt md mdx pdf doc docx odt rtf pptx ppt"],
] as const) {
  for (const ext of exts.split(" ")) ICON_BY_EXTENSION[`.${ext}`] = icon;
}

/** The icon a file is listed with: by kind of content, an image, or a plain file. */
export function fileIcon(path: string): LucideIcon {
  return ICON_BY_EXTENSION[extOf(path)] ?? (isImageExtension(path) ? Image : File);
}

export function binaryMimeForExtension(path: string): string | undefined {
  return BINARY_EXT_MIME[extOf(path)];
}

// ponytail: an extension list, not a content sniff. A binary format missing here opens in the
// Files tab and shows "Cannot display binary file", where "Open in default application" still works.
const EXTERNAL_ONLY_EXTENSIONS = new Set([
  ".xlsx",
  ".xlsm",
  ".xls",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".odt",
  ".ods",
  ".odp",
  ".zip",
  ".7z",
  ".rar",
  ".gz",
  ".tar",
  ".exe",
  ".msi",
  ".dll",
]);

/** Whether the side panel has no viewer for this file, so it should open in the system's own app. */
export function opensExternally(path: string): boolean {
  return EXTERNAL_ONLY_EXTENSIONS.has(extOf(path));
}
