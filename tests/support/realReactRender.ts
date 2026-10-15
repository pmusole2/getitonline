// Renders hooks with the real React, react-dom, and convex/react, so a regression that only shows under the real
// useQueries protocol (for example an unstable request object that loops during render) fails in the test run.
//
// react-dom needs a container and a few DOM globals, but no layout or text fidelity, so the DOM here is a minimal
// in-memory tree. The Convex client is a controlled fake that implements the watch protocol useQueries uses:
// watchQuery, localQueryResult (which throws a failed query's Error, as Convex does), and onUpdate.
import { act, createElement, StrictMode, type ReactNode } from "react";
import * as ReactConvex from "convex/react";
import { getFunctionName } from "convex/server";
import * as ReactDomClient from "react-dom/client";

// The typed view of the modules is declared here, so no cast is needed. Method syntax keeps the parameter types
// bivariant, which accepts the real signatures for a container object and a client object.
interface DomRoot {
  render(children: ReactNode): void;
  unmount(): void;
}

interface DomRenderer {
  createRoot(container: object): DomRoot;
}

interface ProviderModule {
  ConvexProvider(props: {
    client: object;
    children?: ReactNode;
  }): ReactNode | Promise<ReactNode>;
}

const renderer: DomRenderer = ReactDomClient;
const providers: ProviderModule = ReactConvex;

class FakeNode {
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Set<unknown>>();
  readonly attributes = new Map<string, string>();
  nodeValue: string | null = null;

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument | null,
  ) {}

  // react-dom reads these from a root container to choose its namespace, as it does from a real HTML element.
  readonly namespaceURI: string | null = null;

  get tagName(): string {
    return this.nodeName;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (this.parentNode === null) {
      return null;
    }
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get textContent(): string {
    return this.nodeType === 3
      ? (this.nodeValue ?? "")
      : this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes.length = 0;
    if (value !== "") {
      this.appendChild(new FakeNode(3, "#text", this.ownerDocument));
      this.childNodes[0].nodeValue = value;
      this.childNodes[0].parentNode = this;
    }
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, reference: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    const index = reference === null ? -1 : this.childNodes.indexOf(reference);
    if (index < 0) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(index, 0, child);
    }
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: unknown): void {
    const set = this.listeners.get(type) ?? new Set<unknown>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: unknown): void {
    this.listeners.get(type)?.delete(listener);
  }
}

class FakeDocument extends FakeNode {
  activeElement: FakeNode | null = null;
  defaultView: object | null = null;

  constructor() {
    super(9, "#document", null);
  }

  createElement(tagName: string): FakeNode {
    return new FakeNode(1, tagName.toUpperCase(), this);
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode(3, "#text", this);
    node.nodeValue = value;
    return node;
  }

  createComment(value: string): FakeNode {
    const node = new FakeNode(8, "#comment", this);
    node.nodeValue = value;
    return node;
  }
}

// react-dom checks for a window with a document, and reads a few DOM constructors for focus handling.
function installWindow(document: FakeDocument): void {
  const window = {
    event: undefined,
    document,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    HTMLIFrameElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
  };
  document.defaultView = window;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
}

export interface FakeConvexClient {
  // The object given to ConvexProvider. useQueries reads it through context, as it does with the real client.
  readonly client: object;
  // Every live subscription started and ended, as `subscribe:<name>` and `unsubscribe:<name>`.
  readonly lifecycle: string[];
  // Delivers a result for a query name to its active watches. An Error value is delivered as a failed query.
  deliver(name: string, value: unknown): void;
}

interface Watch {
  readonly name: string;
  readonly listeners: Set<() => void>;
}

export function createFakeConvexClient(
  initialResults: Readonly<Record<string, unknown>> = {},
): FakeConvexClient {
  const results = new Map<string, unknown>(Object.entries(initialResults));
  const watches = new Set<Watch>();
  const lifecycle: string[] = [];

  const client = {
    watchQuery(query: Parameters<typeof getFunctionName>[0]) {
      const name = getFunctionName(query);
      const watch: Watch = { name, listeners: new Set() };
      watches.add(watch);
      return {
        localQueryResult(): unknown {
          const value = results.get(name);
          if (value instanceof Error) {
            throw value;
          }
          return value;
        },
        journal(): undefined {
          return undefined;
        },
        // Only a watch that is listened to is a live subscription, as in the Convex client. Creating a watch to read a
        // local result is not one.
        onUpdate(listener: () => void): () => void {
          watch.listeners.add(listener);
          lifecycle.push(`subscribe:${name}`);
          return () => {
            watch.listeners.delete(listener);
            watches.delete(watch);
            lifecycle.push(`unsubscribe:${name}`);
          };
        },
      };
    },
  };

  return {
    client,
    lifecycle,
    deliver(name: string, value: unknown): void {
      results.set(name, value);
      for (const watch of watches) {
        if (watch.name === name) {
          for (const listener of [...watch.listeners]) {
            listener();
          }
        }
      }
    },
  };
}

export interface MountedRoot {
  // Renders the element under the Convex provider. Resolves after React has flushed the render and its effects.
  render(element: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

export interface MountOptions {
  // Wraps the root in StrictMode, so every effect in the tree is set up, torn down, and set up again on mount, as in
  // development. Without it, only a StrictMode element inside the tree replays effects.
  readonly strictRoot?: boolean;
}

// Each test mounts its own root in its own fake document, so renders from one test cannot leak into another.
export function mountUnderConvex(
  convex: FakeConvexClient,
  options: MountOptions = {},
): MountedRoot {
  const document = new FakeDocument();
  installWindow(document);
  const root = renderer.createRoot(document.createElement("div"));
  const wrap = (element: ReactNode): ReactNode => {
    const provided = createElement(
      providers.ConvexProvider,
      { client: convex.client },
      element,
    );
    return options.strictRoot
      ? createElement(StrictMode, null, provided)
      : provided;
  };
  return {
    async render(element: ReactNode): Promise<void> {
      await act(async () => {
        root.render(wrap(element));
      });
    },
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

// Runs a delivery inside act, so React flushes the state update it causes before the test reads the output.
export async function deliver(
  convex: FakeConvexClient,
  name: string,
  value: unknown,
): Promise<void> {
  await act(async () => {
    convex.deliver(name, value);
  });
}
