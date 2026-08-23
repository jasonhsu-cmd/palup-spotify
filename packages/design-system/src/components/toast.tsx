import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";

export interface ToastMessage {
  id: string;
  message: string;
}

interface ToastContextValue {
  toast: (message: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <Toaster>");
  }
  return ctx;
}

export function Toaster({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = React.useState<ToastMessage[]>([]);

  const toast = React.useCallback((message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMessages((current) => [...current, { id, message }]);
  }, []);

  const dismiss = React.useCallback((id: string) => {
    setMessages((current) => current.filter((m) => m.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="down">
        {children}
        {messages.map((m) => (
          <ToastPrimitive.Root
            key={m.id}
            duration={4000}
            onOpenChange={(open) => {
              if (!open) dismiss(m.id);
            }}
            className="rounded-full bg-ink px-5 py-[11px] text-[13px] text-white shadow-lg"
          >
            <ToastPrimitive.Description>{m.message}</ToastPrimitive.Description>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-6 left-1/2 z-[300] flex -translate-x-1/2 flex-col items-center gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
