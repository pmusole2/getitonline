// Replaces only the ConvexReactClient constructor for convexSubjectLoader.mjs. Every other export of convex/react is the
// real module, so the real hooks and ConvexProviderWithClerk drive this client through the same protocol the SDK uses:
// setAuth and clearAuth, watchQuery with localQueryResult and onUpdate, query, mutation, and close. The client never
// opens a socket. It answers from a server model that a test controls, and it records every call on its own instance.
export * from "convex/react";

import { getFunctionName } from "convex/server";

type Answer = (args: unknown) => unknown;
type Handler = (args: unknown) => Promise<unknown>;
type FunctionRef = Parameters<typeof getFunctionName>[0];

// The server as the clients see it. Queries with no answer are pending. A held query is pending until the test changes it.
export const server: {
  queries: Map<string, Answer>;
  mutations: Map<string, Handler>;
  // What the server reports after setAuth. A test sets false to model a session the backend no longer accepts.
  authenticated: boolean;
  // Pushes the current answer of a query to every live subscription of that query, as the server does after a change.
  changed(name: string): void;
  // Changes the backend's verdict on the session of every client, as the server does when it stops or resumes accepting
  // the token. Each client reports it through the onChange callback that its setAuth received.
  setAuthenticated(isAuthenticated: boolean): void;
  reset(): void;
} = {
  queries: new Map(),
  mutations: new Map(),
  authenticated: true,
  changed(name: string): void {
    for (const client of clients) {
      client.notify(name);
    }
  },
  setAuthenticated(isAuthenticated: boolean): void {
    this.authenticated = isAuthenticated;
    for (const client of clients) {
      client.reportAuth(isAuthenticated);
    }
  },
  reset(): void {
    this.queries.clear();
    this.mutations.clear();
    this.authenticated = true;
    clients.length = 0;
  },
};

// Every client constructed since the last reset, in construction order.
export const clients: ConvexClientDouble[] = [];

interface Watch {
  readonly name: string;
  readonly listeners: Set<() => void>;
}

export class ConvexClientDouble {
  // Protocol calls on this client only: auth, subscribe and unsubscribe, query, mutation, and close.
  readonly events: string[] = [];
  closed = false;
  private readonly watches = new Set<Watch>();
  // The backend-verdict callback from the last setAuth, kept so the server can report a later change.
  private authListener: ((isAuthenticated: boolean) => void) | null = null;

  constructor(readonly address: string) {
    clients.push(this);
  }

  setAuth(
    fetchToken: (options: {
      forceRefreshToken: boolean;
    }) => Promise<string | null>,
    onChange?: (isAuthenticated: boolean) => void,
  ): void {
    this.events.push("auth:set");
    void fetchToken({ forceRefreshToken: false }).then((token) => {
      this.events.push(`auth:token:${token ?? "none"}`);
    });
    this.authListener = onChange ?? null;
    onChange?.(server.authenticated);
  }

  reportAuth(isAuthenticated: boolean): void {
    this.events.push(`auth:report:${isAuthenticated}`);
    this.authListener?.(isAuthenticated);
  }

  clearAuth(): void {
    this.events.push("auth:clear");
  }

  watchQuery(query: FunctionRef, args: unknown) {
    const name = getFunctionName(query);
    const watch: Watch = { name, listeners: new Set() };
    this.watches.add(watch);
    return {
      localQueryResult(): unknown {
        const answer = server.queries.get(name);
        return answer === undefined ? undefined : answer(args);
      },
      journal(): undefined {
        return undefined;
      },
      onUpdate: (listener: () => void): (() => void) => {
        watch.listeners.add(listener);
        this.events.push(`subscribe:${name}`);
        return () => {
          watch.listeners.delete(listener);
          this.watches.delete(watch);
          this.events.push(`unsubscribe:${name}`);
        };
      },
    };
  }

  async query(query: FunctionRef, args: unknown): Promise<unknown> {
    const name = getFunctionName(query);
    this.events.push(`query:${name}`);
    const answer = server.queries.get(name);
    return answer === undefined ? undefined : answer(args);
  }

  async mutation(mutation: FunctionRef, args: unknown): Promise<unknown> {
    const name = getFunctionName(mutation);
    this.events.push(`mutation:${name}`);
    const handler = server.mutations.get(name);
    if (handler === undefined) {
      throw new Error(`no mutation handler for ${name}`);
    }
    return handler(args);
  }

  async close(): Promise<void> {
    this.events.push("close");
    this.closed = true;
  }

  notify(name: string): void {
    for (const watch of this.watches) {
      if (watch.name === name) {
        for (const listener of [...watch.listeners]) {
          listener();
        }
      }
    }
  }
}

// Replaces the SDK export for the app code. The explicit export shadows the star export of the same name.
export { ConvexClientDouble as ConvexReactClient };
