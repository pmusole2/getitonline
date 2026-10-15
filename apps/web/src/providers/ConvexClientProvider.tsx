"use client";

/** @jsxRuntime automatic */
import { ReactNode, useEffect, useRef, useState } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, useAuth } from "@clerk/nextjs";

// ConvexProviderWithClerk restarts authentication only when the organization changes, not when the Clerk user does. So
// each Clerk subject gets its own client, through a key: a switch remounts the provider with an empty query cache and a
// fresh websocket that authenticates as the new subject. The signed-out state has its own client too.
const SIGNED_OUT_SUBJECT = "signed-out";

// The server renders with one client for the process, as the module-level client did before. A client per render would
// open a connection and never close it, because effects do not run on the server.
let serverClient: ConvexReactClient | null = null;

function createConvexClient(): ConvexReactClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL!;
  if (typeof window === "undefined") {
    serverClient ??= new ConvexReactClient(url);
    return serverClient;
  }
  return new ConvexReactClient(url);
}

export function ConvexClientProvider({ children }: { children?: ReactNode }) {
  return (
    <ClerkProvider
      publishableKey={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!}
    >
      <ConvexSubjectGate>{children}</ConvexSubjectGate>
    </ClerkProvider>
  );
}

// Reads the Clerk subject, which exists only inside ClerkProvider, and keys the client provider by it.
function ConvexSubjectGate({ children }: { children: ReactNode }) {
  const { userId } = useAuth();

  return (
    <ConvexSubjectClientProvider key={userId ?? SIGNED_OUT_SUBJECT}>
      {children}
    </ConvexSubjectClientProvider>
  );
}

function ConvexSubjectClientProvider({ children }: { children: ReactNode }) {
  const [convexClient] = useState(createConvexClient);
  const pendingClose = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Development StrictMode runs this cleanup and setup again while the component stays mounted. The close is deferred
    // one task, so a setup that follows immediately cancels it and keeps the same client open.
    if (pendingClose.current !== null) {
      clearTimeout(pendingClose.current);
      pendingClose.current = null;
    }
    return () => {
      pendingClose.current = setTimeout(() => {
        pendingClose.current = null;
        void convexClient.close();
      }, 0);
    };
  }, [convexClient]);

  return (
    <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}
