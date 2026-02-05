import { Toaster, toast } from 'sonner';

export { Toaster as ErrorToaster };

export function showErrorToast(message: string): void {
  toast.error(message);
}

export function showSuccessToast(message: string): void {
  toast.success(message);
}

export function ToasterRoot(): JSX.Element {
  return (
    <Toaster
      position="bottom-right"
      max={3}
      duration={4000}
    />
  );
}
