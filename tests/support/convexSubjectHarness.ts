// Mounts the real providers and hooks for the subject-switch tests. The Clerk SDKs, the Expo image modules, and the Convex
// client constructor resolve to doubles, through the require hook below. ConvexProviderWithClerk, the convex/react hooks,
// and the React renderer are real. Import this module before any app module that uses those packages: the hook is
// installed when this module loads, and app modules must be loaded after it.
import Module from "node:module";
import { fileURLToPath, URL } from "node:url";
import { createElement, type ReactNode } from "react";
import * as ClerkReact from "convex/react-clerk";

import { clerk, useAuth, type ClerkSubject } from "./convexSubjectDoubles";
import {
  clients,
  server,
  type ConvexClientDouble,
} from "./convexSubjectClientDouble";
import {
  createFakeConvexClient,
  mountUnderConvex,
  type MountedRoot,
} from "./realReactRender";

// Each double replaces one package for every require in the app and test code, except the double's own require of the
// package it doubles (the client double re-exports the real convex/react).
const doubleFile = (name: string): string =>
  fileURLToPath(new URL(`./${name}`, import.meta.url));
const doubles: ReadonlyMap<string, string> = new Map([
  ["@clerk/clerk-expo", doubleFile("convexSubjectDoubles.ts")],
  ["@clerk/nextjs", doubleFile("convexSubjectDoubles.ts")],
  ["expo-image-manipulator", doubleFile("convexSubjectDoubles.ts")],
  ["expo-image-picker", doubleFile("convexSubjectDoubles.ts")],
  [
    "@react-native-async-storage/async-storage",
    doubleFile("convexSubjectDoubles.ts"),
  ],
  ["react-native", doubleFile("convexSubjectDoubles.ts")],
  ["convex/react", doubleFile("convexSubjectClientDouble.ts")],
]);

const requireUnpatched = Module.prototype.require;
Module.prototype.require = function requireWithDoubles(
  this: Module,
  id: string,
): unknown {
  const double = doubles.get(id);
  if (double === undefined || this.filename === double) {
    return requireUnpatched.call(this, id);
  }
  return requireUnpatched.call(this, double);
};

// The typed view of the real ConvexProviderWithClerk. Method syntax keeps the parameter types bivariant, which accepts
// the real signature for a client object that is a test double.
interface ClerkProviderModule {
  ConvexProviderWithClerk(props: {
    client: object;
    useAuth: () => unknown;
    children?: ReactNode;
  }): ReactNode;
}

const clerkProviders: ClerkProviderModule = ClerkReact;

export { clerk, clients, server, type ClerkSubject, type ConvexClientDouble };

export function subject(id: string): ClerkSubject {
  return {
    id,
    email: `${id}@example.invalid`,
    firstName: id,
    lastName: "Test",
  };
}

// Renders a tree under the real ConvexProviderWithClerk with the given client double. The client is not replaced when
// the element changes, which is how a test models one client that stays mounted.
export function mountWithClient(client: ConvexClientDouble): MountedRoot {
  const root = mountUnderConvex(createFakeConvexClient());
  return {
    render: (next) =>
      root.render(
        createElement(
          clerkProviders.ConvexProviderWithClerk,
          { client, useAuth },
          next,
        ),
      ),
    unmount: () => root.unmount(),
  };
}

// Lets promises and timers started by the code under test settle before the test reads the result.
export function settleTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function resetDoubles(): void {
  clerk.user = null;
  clerk.loaded = true;
  server.reset();
}
