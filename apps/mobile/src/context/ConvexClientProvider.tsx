import React from 'react';
import { ConvexProvider, ConvexReactClient } from 'convex/react';

interface ConvexClientProviderProps {
  children: React.ReactNode;
  url: string;
}

export function ConvexClientProvider({ children, url }: ConvexClientProviderProps) {
  const [convexClient] = React.useState(() => new ConvexReactClient(url));

  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}
