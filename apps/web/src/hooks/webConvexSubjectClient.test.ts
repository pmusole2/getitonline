import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import { createElement, StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { useConvex, useQuery } from "convex/react";

import type * as ProviderModule from "../providers/ConvexClientProvider";
import { api } from "../../../../convex/_generated/api";
import {
  createFakeConvexClient,
  mountUnderConvex,
} from "../../../../tests/support/realReactRender";
import { ConvexClientDouble } from "../../../../tests/support/convexSubjectClientDouble";
import {
  clerk,
  clients,
  resetDoubles,
  server,
  settleTasks,
  subject,
} from "../../../../tests/support/convexSubjectHarness";

// Runs the real web ConvexClientProvider with the real ConvexProviderWithClerk and the real convex/react hooks, inside the
// Clerk provider. Only the Clerk SDK and the client constructor are doubles. The server render runs first, before any
// test installs the browser window that the real renderer needs.
process.env.NEXT_PUBLIC_CONVEX_URL = "https://subject-test.example.invalid";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_subject_double";

let ConvexClientProvider: typeof ProviderModule.ConvexClientProvider;
before(async () => {
  ({ ConvexClientProvider } =
    await import("../providers/ConvexClientProvider"));
});

const profileQuery = getFunctionName(api.users.getUserByClerkId);

function isRequest(event: string): boolean {
  return (
    event.startsWith("auth:set") ||
    event.startsWith("subscribe:") ||
    event.startsWith("query:") ||
    event.startsWith("mutation:")
  );
}

// Every client a child received from useConvex, in render order.
const observed: unknown[] = [];

function lastClient(): ConvexClientDouble {
  const last = observed.at(-1);
  if (last instanceof ConvexClientDouble) {
    return last;
  }
  assert.fail("no client was received by a child");
}

function Probe(): ReactNode {
  observed.push(useConvex());
  const current = clerk.user;
  useQuery(
    api.users.getUserByClerkId,
    current ? { clerkId: current.id } : "skip",
  );
  return null;
}

function providerTree(children: ReactNode = createElement(Probe)): ReactNode {
  return createElement(ConvexClientProvider, null, children);
}

describe("web ConvexClientProvider server render", () => {
  it("renders on the server with one process-wide client and never opens a client per render", () => {
    assert.equal(
      globalThis.window,
      undefined,
      "the server render runs before any browser window exists",
    );
    resetDoubles();

    const first = renderToString(
      providerTree(createElement("span", null, "server-child")),
    );
    const second = renderToString(
      providerTree(createElement("span", null, "server-child")),
    );

    assert.ok(first.includes("server-child"), "children render on the server");
    assert.ok(second.includes("server-child"));
    assert.equal(
      clients.length,
      1,
      "repeated server renders reuse the one process-wide client",
    );
    assert.equal(
      clients[0].closed,
      false,
      "the server client is not closed by a render",
    );
  });
});

describe("web ConvexClientProvider creates one Convex client per Clerk subject", () => {
  beforeEach(() => {
    resetDoubles();
    observed.length = 0;
    server.queries.set(profileQuery, () =>
      clerk.user
        ? { _id: `users_${clerk.user.id}`, clerkId: clerk.user.id }
        : null,
    );
  });

  it("switching from subject A to B creates a second client, closes A, and sends B requests only on B", async () => {
    clerk.user = subject("clerk_A");
    const root = mountUnderConvex(createFakeConvexClient());
    await root.render(providerTree());
    const [clientA] = clients;
    assert.ok(clientA, "the first client is created");

    const requestsOnA = clientA.events.length;
    clerk.user = subject("clerk_B");
    await root.render(providerTree());
    await settleTasks();

    assert.equal(
      clients.length,
      2,
      "a Clerk subject change creates one new client",
    );
    const clientB = clients[1];
    assert.equal(clientA.closed, true, "the previous subject client is closed");
    assert.equal(clientB.closed, false, "the new subject client stays open");
    assert.deepEqual(
      clientA.events.slice(requestsOnA).filter(isRequest),
      [],
      "no request goes out on the previous subject client after the switch",
    );
    assert.ok(
      clientB.events.includes("auth:token:token:clerk_B"),
      "B authenticates its own websocket with B token",
    );
    assert.equal(
      lastClient(),
      clientB,
      "child hooks receive the new subject client",
    );
    await root.unmount();
  });

  it("signed-out to A to signed-out creates a client for each state and closes the ones it replaces", async () => {
    const root = mountUnderConvex(createFakeConvexClient());
    await root.render(providerTree());
    clerk.user = subject("clerk_A");
    await root.render(providerTree());
    clerk.user = null;
    await root.render(providerTree());
    await settleTasks();

    assert.equal(
      clients.length,
      3,
      "signed-out, A, and signed-out each get a client",
    );
    assert.deepEqual(
      clients.map((client) => client.closed),
      [true, true, false],
      "only the current signed-out client stays open",
    );
    await root.unmount();
  });

  it("re-rendering the same subject keeps the same client open", async () => {
    clerk.user = subject("clerk_A");
    const root = mountUnderConvex(createFakeConvexClient());
    await root.render(providerTree());
    await root.render(providerTree());
    await settleTasks();

    assert.equal(clients.length, 1, "no new client without a subject change");
    assert.equal(clients[0].closed, false);
    await root.unmount();
  });

  it("unmounting the provider closes its live client", async () => {
    clerk.user = subject("clerk_A");
    const root = mountUnderConvex(createFakeConvexClient());
    await root.render(providerTree());
    const live = lastClient();
    await root.unmount();
    await settleTasks();

    assert.equal(live.closed, true, "no socket outlives the provider");
  });

  it("StrictMode re-running the effects keeps the live client open", async () => {
    clerk.user = subject("clerk_A");
    const root = mountUnderConvex(createFakeConvexClient());
    await root.render(createElement(StrictMode, null, providerTree()));
    await settleTasks();

    const live = lastClient();
    assert.equal(
      live.closed,
      false,
      "a development-only effect replay does not close the client in use",
    );
    assert.ok(live.events.includes(`subscribe:${profileQuery}`));
    await root.unmount();
  });

  it("a StrictMode root replays the provider effects on mount and keeps the live client open", async () => {
    clerk.user = subject("clerk_A");
    const root = mountUnderConvex(createFakeConvexClient(), {
      strictRoot: true,
    });
    await root.render(providerTree());
    await settleTasks();

    const live = lastClient();
    assert.equal(
      live.closed,
      false,
      "the replayed setup cancels the deferred close of the first setup",
    );
    assert.ok(live.events.includes(`subscribe:${profileQuery}`));
    await root.unmount();
    await settleTasks();
    assert.equal(
      live.closed,
      true,
      "unmounting still closes the client after the replay",
    );
  });
});
