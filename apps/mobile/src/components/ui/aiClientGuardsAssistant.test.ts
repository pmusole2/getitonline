import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import * as shared from '../../../../../packages/shared/src/index';
import { api } from '../../../../../convex/_generated/api';
import {
  createControls,
  createHarness,
  findNodes,
  textOf,
  withFallback,
  type Props,
  type RenderedChild,
} from '../../../../../tests/support/componentHarness';

// The real AIAssistant with the real AI hook. The consent prompt, the consent store, the account, and the Convex actions
// are controlled. The sequence under test is the reviewer's: a send waits on consent, the account switches and the
// conversation resets, and the old send resumes. Nothing of the old send may reach the new account's conversation.

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const repoFile = (relativePath: string) => resolve(repoRoot, relativePath);
const assistantFile = repoFile('apps/mobile/src/components/ui/AIAssistant.tsx');
const authFile = repoFile('apps/mobile/src/context/AuthProvider.tsx');
const consentFile = repoFile('apps/mobile/src/services/aiConsent.ts');

const chatReply = { ok: true, source: 'ai', reply: 'Hello from Pinkie', actions: [] };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signedIn(clerkId: string): Props {
  return {
    isLoading: false,
    isSignedIn: true,
    user: { _id: `users|${clerkId}` },
    clerkUser: { id: clerkId },
    authSyncError: null,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function mountAssistant(options: { consented: string[]; holdConsent?: boolean; holdChat?: boolean }) {
  const controls = createControls();
  controls.auth = signedIn('clerk_a');
  const calls: { action: string; args: Props }[] = [];
  const consentGate = deferred<boolean>();
  const chatGate = deferred<unknown>();
  const harness = createHarness({
    controls,
    effects: true,
    convexApi: { api },
    files: {
      [authFile]: withFallback({
        useAppAuth: () => {
          controls.hook('useContext');
          return controls.auth;
        },
      }),
      [consentFile]: withFallback({
        requestAIConsent: () => (options.holdConsent === true ? consentGate.promise : Promise.resolve(true)),
        hasAIConsent: async (subject: string) => options.consented.includes(subject),
      }),
    },
    packages: {
      '@gettitonline/shared': withFallback({ ...shared }),
      '@react-native-async-storage/async-storage': withFallback({
        default: {
          getItem: async () => null,
          setItem: async () => undefined,
        },
      }),
      'expo-crypto': withFallback({ randomUUID: () => '3f2c9a1e-8b7d-4c6a-9e0f-1a2b3c4d5e6f' }),
      'convex/react': withFallback({
        useAction: () => {
          return async (args: Props) => {
            calls.push({ action: 'chat', args });
            if (options.holdChat === true) {
              return chatGate.promise;
            }
            return chatReply;
          };
        },
      }),
    },
  });
  const component = harness.load(assistantFile).AIAssistantModal;
  const props: Props = { visible: true, onClose: () => undefined, currentScreen: 'Home' };
  const render = () => harness.render(component, props).tree;
  const composer = (tree: readonly RenderedChild[]) => {
    const [input] = findNodes(tree, (node) => node.name === 'TextInput');
    if (input === undefined) throw new Error('the composer must be rendered');
    return input.props;
  };
  return {
    controls,
    calls,
    consentGate,
    chatGate,
    render,
    settle: () => harness.settle(),
    switchAccount: (clerkId: string) => {
      controls.auth = signedIn(clerkId);
    },
    draftAndSend: (tree: readonly RenderedChild[], text: string) => {
      const input = composer(tree);
      (input.onChangeText as (value: string) => void)(text);
      return render();
    },
    submit: async (tree: readonly RenderedChild[]) => {
      const onSubmit = composer(tree).onSubmitEditing;
      if (typeof onSubmit !== 'function') throw new Error('submit must be wired');
      await (onSubmit as () => Promise<void>)();
    },
    submitHandler: (tree: readonly RenderedChild[]) => {
      const onSubmit = composer(tree).onSubmitEditing;
      if (typeof onSubmit !== 'function') throw new Error('submit must be wired');
      return onSubmit as () => Promise<void>;
    },
    shows: (tree: readonly RenderedChild[], text: string) => textOf(tree).includes(text),
  };
}

describe('AIAssistant stale-account guards', () => {
  it('the reviewer sequence: a send that waits on consent, a switch to a consented account, and the old send resumes', async () => {
    const assistant = mountAssistant({ consented: ['account:clerk_a', 'account:clerk_b'], holdConsent: true });
    let tree = assistant.render();
    tree = assistant.draftAndSend(tree, "A's private draft");

    const pendingSend = assistant.submit(tree);
    await tick();
    assistant.switchAccount('clerk_b');
    tree = assistant.render();
    assistant.consentGate.resolve(true);
    await pendingSend;
    await assistant.settle();
    tree = assistant.render();

    assert.deepEqual(assistant.calls, [], "A's draft is never sent, as A or as B");
    assert.equal(assistant.shows(tree, "A's private draft"), false, "A's draft never appears in B's conversation");
  });

  it('a reply to a send from the previous account never reaches the new account', async () => {
    const assistant = mountAssistant({ consented: ['account:clerk_a', 'account:clerk_b'], holdChat: true });
    let tree = assistant.render();
    tree = assistant.draftAndSend(tree, 'A asks about A');

    const pendingSend = assistant.submit(tree);
    await tick();
    assert.equal(assistant.calls.length, 1, 'the request reached the backend for A before the switch');
    assistant.switchAccount('clerk_b');
    tree = assistant.render();
    assistant.chatGate.resolve(chatReply);
    await pendingSend;
    await assistant.settle();
    tree = assistant.render();

    assert.equal(assistant.shows(tree, 'Hello from Pinkie'), false, "A's reply is not shown in B's conversation");
  });

  it('a send callback kept from before the switch does nothing after it', async () => {
    const assistant = mountAssistant({ consented: ['account:clerk_a', 'account:clerk_b'] });
    let tree = assistant.render();
    tree = assistant.draftAndSend(tree, "A's draft");
    const staleSubmit = assistant.submitHandler(tree);

    assistant.switchAccount('clerk_b');
    assistant.render();
    await staleSubmit();
    await assistant.settle();

    assert.deepEqual(assistant.calls, []);
  });

  it('after the switch, a fresh send from B is sent once as B and its reply is shown', async () => {
    const assistant = mountAssistant({ consented: ['account:clerk_a', 'account:clerk_b'] });
    assistant.switchAccount('clerk_b');
    let tree = assistant.render();
    tree = assistant.draftAndSend(tree, 'hello from B');

    await assistant.submit(tree);
    await assistant.settle();
    tree = assistant.render();

    assert.equal(assistant.calls.length, 1);
    assert.equal(assistant.calls[0]?.args.message, 'hello from B');
    assert.equal(assistant.shows(tree, 'Hello from Pinkie'), true);
  });
});
