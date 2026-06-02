import { Toaster, toast } from "sonner";

export { Toaster as ErrorToaster };

export function showErrorToast(message: string): void {
  toast.error(message);
}

export function showSuccessToast(message: string): void {
  toast.success(message);
}

export function ToasterRoot() {
  return (
    <Toaster
      position="bottom-right"
      visibleToasts={3}
      duration={4000}
      toastOptions={{
        classNames: {
          success: "[&_svg]:text-green-500",
        },
      }}
    />
  );
}
