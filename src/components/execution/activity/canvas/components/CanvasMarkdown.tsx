import { MarkdownBlock } from "../../MarkdownBlock";

interface Props {
  text?: string;
  [key: string]: unknown;
}

export function CanvasMarkdown({ text }: Props) {
  if (!text) return null;
  return <MarkdownBlock text={text} />;
}
