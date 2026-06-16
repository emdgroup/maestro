import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { Button } from "@/ui/button";

interface Props {
  trigger?: string;
  title?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

export function CanvasModal({ trigger = "Open", title, children }: Props) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline">{trigger}</Button>} />
      <DialogContent>
        {title && (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}
