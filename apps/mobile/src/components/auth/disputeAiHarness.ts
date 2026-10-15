import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import * as shared from '../../../../../packages/shared/src/index';
import { resolveAccountAccess } from '../../../../../packages/shared/src/utils/accountAccess';
import {
  createControls,
  createHarness,
  withFallback,
  type ActionHandler,
  type HarnessControls,
  type Props,
  type RenderResult,
} from '../../../../../tests/support/componentHarness';

// Mounts a real dispute screen with the real AI hook. Only the boundaries are controlled: auth, the consent store and
// prompt, Convex queries, and Convex actions. The shared AI request layer and the adapters run as they do in the app.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);

export const buyerAccount: Props = {
  _id: 'users|buyer',
  clerkId: 'clerk_buyer',
  email: 'buyer@example.invalid',
  firstName: 'Bea',
  lastName: 'Buyer',
  role: 'user',
  isBanned: false,
};

export interface MountOptions {
  readonly file: string;
  readonly account: Props;
  readonly queries: Props;
  readonly actions?: Record<string, ActionHandler>;
  // `prompt` is the answer to the consent prompt the screen shows. `stored` is the consent the request layer checks.
  readonly consent: { readonly prompt: boolean; readonly stored: boolean };
}

export interface MountedScreen {
  readonly controls: HarnessControls;
  readonly render: (props: Props) => RenderResult;
  readonly settle: () => Promise<void>;
  readonly signInAs: (account: Props) => void;
}

function signedIn(account: Props): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    user: account,
    clerkUser: { id: String(account.clerkId) },
    authSyncError: null,
  };
}

export function mountDisputeScreen(options: MountOptions): MountedScreen {
  const controls = createControls();
  controls.auth = signedIn(options.account);
  controls.queries = options.queries;
  controls.actions = options.actions ?? {};
  const harness = createHarness({
    controls,
    effects: true,
    files: {
      [repoFile('apps/mobile/src/context/AuthProvider.tsx')]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
      [repoFile('apps/mobile/src/services/aiConsent.ts')]: withFallback({
        requestAIConsent: async () => options.consent.prompt,
        hasAIConsent: async () => options.consent.stored,
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared, resolveAccountAccess }),
    },
  });
  const component = harness.load(repoFile(options.file)).default;
  return {
    controls,
    render: (props) => harness.render(component, props),
    settle: () => harness.settle(),
    signInAs: (account) => {
      controls.auth = signedIn(account);
    },
  };
}
