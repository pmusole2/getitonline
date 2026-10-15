import { useAuth } from '@clerk/clerk-expo';
import React from 'react';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';

interface ConvexClientProviderProps {
  children: React.ReactNode;
  url: string;
}

// ConvexProviderWithClerk restarts authentication only when the organization changes, not when the Clerk user does. So
// each Clerk subject gets its own client, through a key: a switch remounts the provider with an empty query cache and a
// fresh websocket that authenticates as the new subject. The signed-out state has its own client too.
const SIGNED_OUT_SUBJECT = 'signed-out';

export function ConvexClientProvider({ children, url }: ConvexClientProviderProps) {
  const { userId } = useAuth();

  return (
    <ConvexSubjectClientProvider key={userId ?? SIGNED_OUT_SUBJECT} url={url}>
      {children}
    </ConvexSubjectClientProvider>
  );
}

function ConvexSubjectClientProvider({ children, url }: ConvexClientProviderProps) {
  const [convexClient] = React.useState(() => new ConvexReactClient(url));
  const pendingClose = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    // StrictMode in development runs this cleanup and setup again while the component stays mounted. The close is
    // deferred one task, so a setup that follows immediately cancels it and keeps the same client open.
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
