export interface ToastRegionProps {
  message: string | null;
}

export function ToastRegion({ message }: ToastRegionProps) {
  if (!message) {
    return null;
  }

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {message}
    </div>
  );
}
