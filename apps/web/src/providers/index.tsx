"use client";

import { ReactNode } from "react";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { GuestCartProvider } from "./GuestCartProvider";
import { ThemeProvider } from "./ThemeProvider";
import { QueryProvider } from "./QueryProvider";
import { Toaster } from "@/components/ui/sonner";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ConvexClientProvider>
      <GuestCartProvider>
        <QueryProvider>
          <ThemeProvider>
            {children}
            <Toaster position="top-right" richColors />
          </ThemeProvider>
        </QueryProvider>
      </GuestCartProvider>
    </ConvexClientProvider>
  );
}
