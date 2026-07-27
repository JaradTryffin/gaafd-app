"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

export type ToastVariant = "success" | "error";

type ToastState = {
  message: string;
  variant: ToastVariant;
} | null;

type ToastContextValue = {
  showToast: (message: string, variant?: ToastVariant) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 2600;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, variant: ToastVariant = "success") => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setToast({ message, variant });
    timeoutRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-[11px] px-5 py-3 text-[13.5px] font-medium text-white shadow-[0_12px_30px_rgba(0,0,0,.25)]"
          style={{
            background: toast.variant === "success" ? "var(--primary)" : "var(--destructive)",
            animation: "gfToast .3s ease",
          }}
        >
          <span className="text-[15px]">{toast.variant === "success" ? "✓" : "!"}</span>
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
