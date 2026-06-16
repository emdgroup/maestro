import { File, FileCode, FileText, Image as ImageIcon } from "lucide-react";
import { isImageExtension } from "../fileTypeUtils";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "rs", "py", "go", "rb",
  "java", "c", "cpp", "h", "cs", "swift", "kt",
]);
const TEXT_EXTENSIONS = new Set([
  "md", "txt", "toml", "yaml", "yml", "json",
  "html", "css", "sql", "sh", "graphql",
]);

export function iconForFilePath(path: string, className: string) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (CODE_EXTENSIONS.has(ext)) return <FileCode className={className} />;
  if (TEXT_EXTENSIONS.has(ext)) return <FileText className={className} />;
  if (isImageExtension(path)) return <ImageIcon className={className} />;
  return <File className={className} />;
}
