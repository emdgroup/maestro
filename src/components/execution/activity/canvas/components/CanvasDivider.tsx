import { Separator } from "@/ui/separator";

interface Props {
  orientation?: "horizontal" | "vertical";
  [key: string]: unknown;
}

export function CanvasDivider({ orientation = "horizontal" }: Props) {
  return <Separator orientation={orientation} />;
}
