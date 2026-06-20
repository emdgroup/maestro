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
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".rs": "rust",
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

export function isPdfExtension(path: string): boolean {
  return extOf(path) === ".pdf";
}

export function langForExtension(path: string): string | undefined {
  return EXT_TO_LANG[extOf(path)];
}

export function imageMimeForExtension(path: string): string {
  return IMAGE_MIME[extOf(path)] ?? "image/png";
}
