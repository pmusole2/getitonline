// Doubles for the Clerk SDKs and the Expo image modules, used through convexSubjectLoader.mjs. A test controls the
// signed-in Clerk user and whether image compression waits. Only the members the app code under test calls are present.
import type { ReactNode } from "react";

export interface ClerkSubject {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

// The signed-in Clerk user, or null when signed out. Every hook reads it at call time, so a re-render sees a change.
export const clerk: { user: ClerkSubject | null; loaded: boolean } = {
  user: null,
  loaded: true,
};

export function useAuth() {
  const userId = clerk.user?.id;
  return {
    isLoaded: clerk.loaded,
    isSignedIn: userId !== undefined,
    userId,
    orgId: undefined,
    orgRole: undefined,
    getToken: async (): Promise<string | null> =>
      userId === undefined ? null : `token:${userId}`,
    signOut: async (): Promise<void> => {
      clerk.user = null;
    },
  };
}

// Clerk returns the same user object for as long as the signed-in user does, so a dependency on it does not change on
// every render. The view is cached per subject object to keep that identity.
const userViews = new WeakMap<ClerkSubject, object>();

export function useUser() {
  const subject = clerk.user;
  if (subject === null) {
    return { user: null };
  }
  let view = userViews.get(subject);
  if (view === undefined) {
    view = {
      id: subject.id,
      primaryEmailAddress: { emailAddress: subject.email },
      firstName: subject.firstName,
      lastName: subject.lastName,
      imageUrl: undefined,
    };
    userViews.set(subject, view);
  }
  return { user: view };
}

// The app root wraps the tree in ClerkProvider. Rendering the children unchanged is all the providers need from it.
export function ClerkProvider(props: { children?: ReactNode }): ReactNode {
  return props.children ?? null;
}

// Image compression resolves immediately unless a test holds it, then the test releases each held call.
export interface HeldCompression {
  readonly uri: string;
  release(result: { uri: string }): void;
}

export interface PickedAsset {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly fileSize: number;
  readonly mimeType: string;
}

// What the library picker returns to the next pick. Only the fields the upload hook reads are present.
export const imageControl: {
  holdCompression: boolean;
  held: HeldCompression[];
  pick: { canceled: boolean; assets: PickedAsset[] };
} = {
  holdCompression: false,
  held: [],
  pick: { canceled: true, assets: [] },
};

export const MediaTypeOptions = { Images: "images" } as const;

export function launchImageLibraryAsync(): Promise<{
  canceled: boolean;
  assets: PickedAsset[];
}> {
  return Promise.resolve(imageControl.pick);
}

export const SaveFormat = { JPEG: "jpeg" } as const;

export function manipulateAsync(
  uri: string,
  _actions: unknown,
  _options: unknown,
): Promise<{ uri: string }> {
  if (!imageControl.holdCompression) {
    return Promise.resolve({ uri: `${uri}.compressed.jpg` });
  }
  return new Promise((resolve) => {
    imageControl.held.push({ uri, release: resolve });
  });
}

// The native modules the auth services import. Reads of stored AI consent resolve to nothing, and alerts never show.
const storage = new Map<string, string>();

export default {
  async getItem(key: string): Promise<string | null> {
    return storage.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    storage.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    storage.delete(key);
  },
};

export const Alert = {
  alert(): void {
    return undefined;
  },
};

export const Linking = {
  openURL: async (): Promise<void> => undefined,
};
