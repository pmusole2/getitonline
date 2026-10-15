// Runs real component functions from app source under controlled hooks.
//
// External packages resolve to inert stubs, so no native or browser runtime loads. App modules are
// transpiled from source and evaluated on demand. Hook calls are recorded per component instance, and a
// later render that changes a component's hook order or count throws, as React does. A component's hook
// state is dropped once it leaves the rendered tree, so unmounting discards local state.
//
// Effects are off by default. With `effects: true`, each render runs the effects whose dependencies changed,
// after the tree is produced, with layout effects before passive effects. A superseded effect's cleanup runs
// before its replacement, and unmount cleanups run before new setup. This models lifecycle ordering, not
// browser paint or React's scheduler. `settle()` lets promises started by effects and mutations resolve. State an effect
// sets shows in the next render, so a test renders again to observe it, as a state update would trigger.
//
// Fixtures are loose: fields a test does not set resolve to stubs, so tests assert the gate and the query
// state rather than every field a screen might render.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ts from "typescript";

export type Props = Record<string, unknown>;

export interface QueryCall {
  readonly name: string;
  readonly args: unknown;
}

export interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

// Lifecycle of a useQueries request. `identity-change` means a render received a different request object than the
// one it held before. Each request is then treated as a new subscription, which is stricter than Convex (it compares
// names and args), so an unstable request object shows up as churn in these events.
export interface QueryWatchEvent {
  readonly event: "subscribe" | "unsubscribe" | "identity-change";
  readonly name: string;
}

export type MutationHandler = (args: unknown) => Promise<unknown>;

export type ActionHandler = (args: unknown) => Promise<unknown>;

export interface ConvexAuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
}

// Values a test controls. Overrides read them at call time, so one controls object drives a render sequence.
// `hook` lets a stand-in hook record itself in the calling component's hook order, as a real hook does.
export interface HarnessControls {
  auth: Props;
  queries: Props;
  params: Props;
  pathname: string;
  convexAuth: ConvexAuthState;
  mutations: Record<string, MutationHandler>;
  // Handlers for Convex actions, keyed by function name. An action with no handler resolves to undefined.
  actions: Record<string, ActionHandler>;
  calls: RecordedCall[];
  queryCalls: QueryCall[];
  queryWatches: QueryWatchEvent[];
  hook: (kind: string) => void;
}

export interface RenderedNode {
  readonly name: string;
  readonly props: Props;
  readonly children: readonly RenderedChild[];
}

export type RenderedChild = RenderedNode | string;

export interface RenderResult {
  readonly tree: readonly RenderedChild[];
  readonly queryCalls: readonly QueryCall[];
  readonly hookTraces: ReadonlyMap<string, readonly string[]>;
}

export interface HarnessOptions {
  readonly controls: HarnessControls;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, Props>>;
  readonly packages?: Readonly<Record<string, Props>>;
  // Runs effects after each render, with cleanup on re-run and unmount. Off by default, because most screens
  // only need their hooks recorded and running their effects would perform unrelated side effects.
  readonly effects?: boolean;
  // Replaces the generated Convex API module, so a test can use real function references with a real useQueries.
  readonly convexApi?: Props;
}

export interface Harness {
  load(file: string): Props;
  render(component: unknown, props?: Props): RenderResult;
  // Lets promises started by effects and mutations resolve before the next render.
  settle(): Promise<void>;
}

interface Slot {
  readonly kind: string;
  initialized: boolean;
  value: unknown;
  deps: readonly unknown[] | undefined;
  cleanup: unknown;
}

interface Frame {
  slots: Slot[];
  trace: string[];
  cursor: number;
  expected: number | undefined;
}

interface QueuedEffect {
  readonly kind: "useEffect" | "useLayoutEffect";
  readonly slot: Slot;
  readonly run: () => unknown;
}

type Callable = (...args: unknown[]) => unknown;
type Component = (props: Props) => unknown;

const FRAGMENT = Symbol.for("harness.fragment");
const PASSTHROUGH = new Set(["then", "valueOf", "toString", "toJSON"]);
const stubCache = new Map<string, Callable>();
const stubNames = new WeakMap<object, string>();
const referenceNames = new WeakMap<object, string>();
const compiled = new Map<string, string>();
const apiModule: Props = { api: referenceFor("") };

export function createControls(): HarnessControls {
  return {
    auth: {},
    queries: {},
    params: {},
    pathname: "/",
    convexAuth: { isLoading: false, isAuthenticated: true },
    mutations: {},
    actions: {},
    calls: [],
    queryCalls: [],
    queryWatches: [],
    hook: () => undefined,
  };
}

export function createHarness(options: HarnessOptions): Harness {
  const { controls } = options;
  const aliases = options.aliases ?? {};
  const runEffects = options.effects === true;
  const frames = new Map<string, Frame>();
  const loaded = new Map<string, Props>();
  const traces = new Map<string, string[]>();
  const queued: QueuedEffect[] = [];
  let touched = new Set<string>();
  let active: Frame | undefined;

  const record = (name: string, args: unknown[]) => {
    controls.calls.push({ name, args });
  };

  const recordWatches = (
    names: readonly string[],
    event: QueryWatchEvent["event"],
  ) => {
    for (const name of names) {
      controls.queryWatches.push({ event, name });
    }
  };

  function hook(kind: string): Slot {
    if (active === undefined) {
      throw new Error(`${kind} was called outside a component render`);
    }
    const frame = active;
    const index = frame.cursor;
    frame.cursor += 1;
    frame.trace.push(kind);
    const existing: Slot | undefined = frame.slots[index];
    if (existing === undefined) {
      const created: Slot = {
        kind,
        initialized: false,
        value: undefined,
        deps: undefined,
        cleanup: undefined,
      };
      frame.slots[index] = created;
      return created;
    }
    if (existing.kind !== kind) {
      throw new Error(
        `Hook order changed at position ${index}: ${existing.kind} became ${kind}`,
      );
    }
    return existing;
  }

  function invoke(component: Component, props: Props, path: string): unknown {
    touched.add(path);
    let frame = frames.get(path);
    if (frame === undefined) {
      frame = { slots: [], trace: [], cursor: 0, expected: undefined };
      frames.set(path, frame);
    }
    frame.cursor = 0;
    frame.trace = [];
    const previous = active;
    active = frame;
    try {
      const output: unknown = component(props);
      const name = component.name || "Component";
      if (frame.expected === undefined) {
        frame.expected = frame.trace.length;
      } else if (frame.expected !== frame.trace.length) {
        throw new Error(
          `${name} changed its hook count from ${frame.expected} to ${frame.trace.length}`,
        );
      }
      traces.set(name, [...frame.trace]);
      return output;
    } finally {
      active = previous;
    }
  }

  function childrenOf(props: Props, path: string): RenderedChild[] {
    const children: RenderedChild[] = [];
    expand(props.children, path, children);
    return children;
  }

  function expand(node: unknown, path: string, out: RenderedChild[]): void {
    if (node === null || node === undefined || typeof node === "boolean") {
      return;
    }
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (typeof node === "number") {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child: unknown, index: number) =>
        expand(child, `${path}.${index}`, out),
      );
      return;
    }
    if (!isElement(node)) {
      return;
    }
    const { type, props, key } = node;
    if (type === FRAGMENT) {
      expand(props.children, `${path}#`, out);
      return;
    }
    if (typeof type === "string") {
      out.push({ name: type, props, children: childrenOf(props, `${path}>`) });
      return;
    }
    if (!isComponent(type)) {
      return;
    }
    const stubName = stubNames.get(type);
    if (stubName !== undefined) {
      out.push({
        name: stubName,
        props,
        children: childrenOf(props, `${path}>`),
      });
      return;
    }
    const name = type.name || "Component";
    const childPath = `${path}/${name}${keyPart(key)}`;
    const output = invoke(type, props, childPath);
    const children: RenderedChild[] = [];
    expand(output, `${childPath}>`, children);
    out.push({ name, props, children });
  }

  // Cleanups of superseded effects run before their replacements, as React runs them within one commit.
  function commitEffects(): void {
    const pending = queued.splice(0);
    for (const kind of ["useLayoutEffect", "useEffect"] as const) {
      const effects = pending.filter((entry) => entry.kind === kind);
      for (const entry of effects) {
        runCleanup(entry.slot);
      }
      for (const entry of effects) {
        entry.slot.cleanup = entry.run();
      }
    }
  }

  function queueEffect(
    kind: QueuedEffect["kind"],
    effect: unknown,
    deps: unknown,
  ): void {
    const slot = hook(kind);
    const nextDeps = Array.isArray(deps) ? deps : undefined;
    if (!slot.initialized || !sameDeps(slot.deps, nextDeps)) {
      slot.initialized = true;
      slot.deps = nextDeps;
      if (runEffects && typeof effect === "function") {
        const callback = effect;
        queued.push({
          kind,
          slot,
          run: () => Reflect.apply(callback, undefined, []),
        });
      }
    }
  }

  controls.hook = (kind: string) => {
    hook(kind);
  };

  const reactExports: Props = {
    __esModule: true,
    Fragment: FRAGMENT,
    createContext: (defaultValue: unknown) => ({
      Provider: stubFor("Provider"),
      defaultValue,
    }),
    useContext: (context: unknown) => {
      hook("useContext");
      return isRecord(context) ? context.defaultValue : undefined;
    },
    useState: (initial: unknown) => {
      const slot = hook("useState");
      if (!slot.initialized) {
        slot.initialized = true;
        slot.value =
          typeof initial === "function" ? call(initial, []) : initial;
      }
      const setState = (next: unknown) => {
        slot.value =
          typeof next === "function" ? call(next, [slot.value]) : next;
      };
      return [slot.value, setState];
    },
    useReducer: (reducer: unknown, initial: unknown) => {
      const slot = hook("useReducer");
      if (!slot.initialized) {
        slot.initialized = true;
        slot.value = initial;
      }
      const dispatch = (action: unknown) => {
        slot.value = call(reducer, [slot.value, action]);
      };
      return [slot.value, dispatch];
    },
    useMemo: (factory: unknown, deps: unknown) => {
      const slot = hook("useMemo");
      const nextDeps = Array.isArray(deps) ? deps : undefined;
      if (!slot.initialized || !sameDeps(slot.deps, nextDeps)) {
        slot.initialized = true;
        slot.deps = nextDeps;
        slot.value = call(factory, []);
      }
      return slot.value;
    },
    useCallback: (callback: unknown) => {
      hook("useCallback");
      return callback;
    },
    useRef: (initial: unknown) => {
      const slot = hook("useRef");
      if (!slot.initialized) {
        slot.initialized = true;
        slot.value = { current: initial };
      }
      return slot.value;
    },
    useId: () => {
      hook("useId");
      return ":harness:";
    },
    useEffect: (effect: unknown, deps: unknown) =>
      queueEffect("useEffect", effect, deps),
    useLayoutEffect: (effect: unknown, deps: unknown) =>
      queueEffect("useLayoutEffect", effect, deps),
    useImperativeHandle: () => hook("useImperativeHandle"),
    useDebugValue: () => hook("useDebugValue"),
    memo: (component: unknown) => component,
    forwardRef: (render: unknown) => render,
  };
  reactExports.default = reactExports;

  const jsxRuntime: Props = {
    __esModule: true,
    Fragment: FRAGMENT,
    jsx: element,
    jsxs: element,
    jsxDEV: element,
  };

  const convexReact: Props = {
    __esModule: true,
    // Imperative client queries read the controlled result (including deferred promises), without subscriptions.
    useConvex: () => {
      hook("useConvex");
      return {
        query: async (reference: unknown, args: unknown) => {
          const name = referenceName(reference);
          record(`query:${name}`, [args]);
          controls.queryCalls.push({ name, args });
          return controls.queries[name];
        },
      };
    },
    // As in Convex, useQuery throws a failed query's error, so a server error reaches the nearest error boundary.
    useQuery: (reference: unknown, args: unknown) => {
      hook("useQuery");
      const name = referenceName(reference);
      controls.queryCalls.push({ name, args });
      const result = args === "skip" ? undefined : controls.queries[name];
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    // As in Convex, useQueries returns a failed query's error as a value instead of throwing. As in useSubscription,
    // the subscription is an effect keyed on the request object: it starts on commit, and a new request object ends
    // the old subscription and starts a new one.
    useQueries: (requests: unknown) => {
      const slot = hook("useQueries");
      if (slot.initialized && slot.value !== requests) {
        recordWatches(queryNames(requests), "identity-change");
      }
      slot.initialized = true;
      slot.value = requests;
      queueEffect(
        "useEffect",
        () => {
          recordWatches(queryNames(requests), "subscribe");
          return () => recordWatches(queryNames(requests), "unsubscribe");
        },
        [requests],
      );
      const results: Props = {};
      if (isRecord(requests)) {
        for (const [key, request] of Object.entries(requests)) {
          const name = isRecord(request)
            ? referenceName(request.query)
            : "unknown";
          controls.queryCalls.push({
            name,
            args: isRecord(request) ? request.args : undefined,
          });
          results[key] = controls.queries[name];
        }
      }
      return results;
    },
    // Memoized per slot, as Convex's useAction is, so the bound function is stable across renders.
    useAction: (reference: unknown) => {
      const slot = hook("useAction");
      if (!slot.initialized) {
        slot.initialized = true;
        const name = referenceName(reference);
        slot.value = (...args: unknown[]) => {
          record(`action:${name}`, args);
          const handler: ActionHandler | undefined = controls.actions[name];
          return handler === undefined
            ? Promise.resolve(undefined)
            : handler(args[0]);
        };
      }
      return slot.value;
    },
    // Memoized per slot, as Convex's useMutation is, so effects that depend on it are not re-run each render.
    useMutation: (reference: unknown) => {
      const slot = hook("useMutation");
      if (!slot.initialized) {
        slot.initialized = true;
        const name = referenceName(reference);
        slot.value = (...args: unknown[]) => {
          record(`mutation:${name}`, args);
          const handler: MutationHandler | undefined = controls.mutations[name];
          return handler === undefined
            ? Promise.resolve(undefined)
            : handler(args[0]);
        };
      }
      return slot.value;
    },
    useConvexAuth: () => {
      hook("useConvexAuth");
      return controls.convexAuth;
    },
  };

  const navigation: Props = {
    navigate: (...args: unknown[]) => record("navigation.navigate", args),
    goBack: (...args: unknown[]) => record("navigation.goBack", args),
    replace: (...args: unknown[]) => record("navigation.replace", args),
  };
  const reactNavigation: Props = {
    __esModule: true,
    useNavigation: () => {
      hook("useContext");
      return navigation;
    },
  };

  const router: Props = {
    push: (...args: unknown[]) => record("router.push", args),
    replace: (...args: unknown[]) => record("router.replace", args),
    back: (...args: unknown[]) => record("router.back", args),
    refresh: (...args: unknown[]) => record("router.refresh", args),
  };
  const nextNavigation: Props = {
    __esModule: true,
    usePathname: () => {
      hook("useContext");
      return controls.pathname;
    },
    useParams: () => {
      hook("useContext");
      return controls.params;
    },
    useRouter: () => {
      hook("useContext");
      return router;
    },
  };

  const packages = new Map<string, unknown>([
    ["react", withFallback(reactExports)],
    ["react/jsx-runtime", withFallback(jsxRuntime)],
    ["convex/react", withFallback(convexReact)],
    ["@react-navigation/native", withFallback(reactNavigation)],
    ["next/navigation", withFallback(nextNavigation)],
  ]);
  for (const [specifier, exports] of Object.entries(options.packages ?? {})) {
    packages.set(specifier, exports);
  }

  function requireFrom(file: string): (specifier: string) => unknown {
    return (specifier) => {
      if (specifier.endsWith("/_generated/api")) {
        return options.convexApi ?? apiModule;
      }
      const external = packages.get(specifier);
      if (external !== undefined) {
        return external;
      }
      const local = resolveLocal(specifier, file, aliases);
      if (local !== undefined) {
        return load(local);
      }
      return stubFor(specifier);
    };
  }

  function load(file: string): Props {
    const override = options.files?.[file];
    if (override !== undefined) {
      return override;
    }
    const cached = loaded.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const exported: Props = {};
    loaded.set(file, exported);
    const moduleRecord: { exports: Props } = { exports: exported };
    const evaluate = new Function(
      "require",
      "module",
      "exports",
      compile(file),
    );
    evaluate(requireFrom(file), moduleRecord, exported);
    return moduleRecord.exports;
  }

  return {
    load,
    render(component: unknown, props: Props = {}): RenderResult {
      controls.queryCalls.splice(0);
      traces.clear();
      touched = new Set<string>();
      const tree: RenderedChild[] = [];
      expand({ type: component, props }, "root", tree);
      for (const [path, frame] of [...frames.entries()]) {
        if (!touched.has(path)) {
          for (const slot of frame.slots) {
            runCleanup(slot);
          }
          frames.delete(path);
        }
      }
      commitEffects();
      return {
        tree,
        queryCalls: [...controls.queryCalls],
        hookTraces: new Map(traces),
      };
    },
    settle(): Promise<void> {
      return new Promise<void>((resolveSettled) => {
        setImmediate(resolveSettled);
      });
    },
  };
}

export function withFallback(exports: Props): Props {
  return new Proxy(exports, {
    get(target, property) {
      if (typeof property === "symbol") {
        return Reflect.get(target, property);
      }
      if (property in target) {
        return target[property];
      }
      return property === "__esModule" ? true : stubFor(property);
    },
  });
}

// Wraps nested plain objects too, so fixtures can omit fields a screen renders but a test does not assert.
export function fixture(value: Props): Props {
  const wrapped: Props = {};
  for (const [key, child] of Object.entries(value)) {
    wrapped[key] =
      isRecord(child) && !Array.isArray(child) ? fixture(child) : child;
  }
  return withFallback(wrapped);
}

export function textOf(nodes: readonly RenderedChild[]): string {
  return nodes
    .map((child) =>
      typeof child === "string" ? child : textOf(child.children),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function findNodes(
  nodes: readonly RenderedChild[],
  matches: (node: RenderedNode) => boolean,
): RenderedNode[] {
  const found: RenderedNode[] = [];
  for (const child of nodes) {
    if (typeof child === "string") {
      continue;
    }
    if (matches(child)) {
      found.push(child);
    }
    found.push(...findNodes(child.children, matches));
  }
  return found;
}

export function hasNode(
  nodes: readonly RenderedChild[],
  name: string,
): boolean {
  return findNodes(nodes, (node) => node.name === name).length > 0;
}

// Calls the handler of the first element whose own text is exactly `label`.
export function pressButton(
  nodes: readonly RenderedChild[],
  label: string,
  event: "onPress" | "onClick" = "onPress",
): boolean {
  const [button] = findNodes(
    nodes,
    (node) =>
      typeof node.props[event] === "function" &&
      textOf(node.children) === label,
  );
  const handler = button?.props[event];
  if (typeof handler !== "function") {
    return false;
  }
  Reflect.apply(handler, undefined, []);
  return true;
}

function stubFor(name: string): Callable {
  const cached = stubCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const target: Callable = () => undefined;
  const stub = new Proxy(target, {
    get(fn, property) {
      if (property === "displayName") {
        return name;
      }
      if (property === "__esModule") {
        return true;
      }
      if (typeof property === "symbol" || PASSTHROUGH.has(property)) {
        return Reflect.get(fn, property);
      }
      return stubFor(property);
    },
    apply: () => stubFor("call"),
    construct: () => stubFor("construct"),
  });
  stubCache.set(name, stub);
  stubNames.set(stub, name);
  return stub;
}

function referenceFor(path: string): Callable {
  const target: Callable = () => undefined;
  const reference = new Proxy(target, {
    get(fn, property) {
      if (typeof property === "symbol") {
        return Reflect.get(fn, property);
      }
      return referenceFor(path === "" ? property : `${path}.${property}`);
    },
  });
  referenceNames.set(reference, path);
  return reference;
}

function referenceName(reference: unknown): string {
  if (typeof reference === "function") {
    const name = referenceNames.get(reference);
    if (name !== undefined) {
      return name;
    }
  }
  return "unknown";
}

// The runtime passes a key as the third argument. As in React, a changed key remounts the component, so its hook state
// is dropped rather than carried over to the new key.
function element(type: unknown, props: unknown, key?: unknown): Props {
  return { type, props: isRecord(props) ? props : {}, key };
}

function keyPart(key: unknown): string {
  return key === undefined ? "" : `[${String(key)}]`;
}

function call(fn: unknown, args: unknown[]): unknown {
  return typeof fn === "function"
    ? Reflect.apply(fn, undefined, args)
    : undefined;
}

function queryNames(requests: unknown): string[] {
  if (!isRecord(requests)) {
    return [];
  }
  return Object.values(requests).map((request) =>
    isRecord(request) ? referenceName(request.query) : "unknown",
  );
}

function runCleanup(slot: Slot): void {
  const cleanup = slot.cleanup;
  slot.cleanup = undefined;
  if (typeof cleanup === "function") {
    Reflect.apply(cleanup, undefined, []);
  }
}

function sameDeps(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (
    previous === undefined ||
    next === undefined ||
    previous.length !== next.length
  ) {
    return false;
  }
  return previous.every((value, index) => Object.is(value, next[index]));
}

function isRecord(value: unknown): value is Props {
  return typeof value === "object" && value !== null;
}

function isComponent(value: unknown): value is Component {
  return typeof value === "function";
}

function isElement(
  value: unknown,
): value is { type: unknown; props: Props; key?: unknown } {
  return isRecord(value) && "type" in value && isRecord(value.props);
}

function resolveLocal(
  specifier: string,
  fromFile: string,
  aliases: Readonly<Record<string, string>>,
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    for (const [prefix, directory] of Object.entries(aliases)) {
      if (specifier.startsWith(prefix)) {
        base = resolve(directory, specifier.slice(prefix.length));
        break;
      }
    }
  }
  if (base === undefined) {
    return undefined;
  }
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

function compile(file: string): string {
  const cached = compiled.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  compiled.set(file, output);
  return output;
}
