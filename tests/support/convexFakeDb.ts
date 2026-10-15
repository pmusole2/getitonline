// In-memory stand-in for the Convex database and auth context. Handler tests run the real Convex handler bodies
// against it, so authorization is checked by execution rather than by reading source text.
//
// Modelled: `get`, `patch` (shallow merge), `insert`, `delete`, and queries with `withIndex` and `filter` equality,
// ordered by `order` and limited by `take`, then read with `first` or `collect`. An index declared in `indexes` orders
// rows by its fields in index order; any other query orders rows by creation, as Convex does for `_creationTime`.
// Not modelled: `or` filters, and rollback. A Convex mutation that throws rolls back all of its writes; this fake does
// not, so a handler under test must run every check before its first write.

import { getFunctionName, type SchedulableFunctionReference } from "convex/server";

export type ScheduledInvocation = {
  id: string;
  target: SchedulableFunctionReference;
  name: string;
  args: Record<string, unknown>;
  dueAt: number;
  cancelled: boolean;
};

export type Row = { _id: string } & Record<string, unknown>;
export type Tables = Record<string, Row[]>;
// Table name -> index name -> indexed fields, in index order, e.g. { messages: { by_dispute_created: ["disputeId", "createdAt"] } }.
export type Indexes = Record<string, Record<string, string[]>>;

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  const a = String(left);
  const b = String(right);
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareByFields(fields: string[]) {
  return (a: Row, b: Row) => {
    for (const field of fields) {
      const order = compareValues(a[field], b[field]);
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  };
}

const schedulers = new WeakMap<object, ReturnType<typeof createDb>["scheduler"]>();

export function createDb(initial: Tables, indexes: Indexes = {}) {
  const tables: Tables = structuredClone(initial);
  let nextId = 1;
  const scheduled: ScheduledInvocation[] = [];
  const scheduler = {
    async runAt(timestamp: number | Date, target: SchedulableFunctionReference, args: Record<string, unknown> = {}) {
      const dueAt = timestamp instanceof Date ? timestamp.getTime() : timestamp;
      if (!Number.isFinite(dueAt)) {
        throw new Error("Invalid scheduler timestamp");
      }
      const id = `_scheduled_functions|${scheduled.length + 1}`;
      scheduled.push({
        id,
        target,
        name: getFunctionName(target),
        args: structuredClone(args),
        dueAt,
        cancelled: false,
      });
      return id;
    },
    async runAfter(delayMs: number, target: SchedulableFunctionReference, args: Record<string, unknown> = {}) {
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error("Invalid scheduler delay");
      }
      return await scheduler.runAt(Date.now() + delayMs, target, args);
    },
    async cancel(id: string) {
      const job = scheduled.find((entry) => entry.id === id);
      if (!job) {
        throw new Error("Missing scheduled invocation");
      }
      job.cancelled = true;
    },
  };
  const allRows = () => Object.values(tables).flat();

  const db = {
    tables,
    scheduled,
    scheduler,
    query(table: string) {
      const filters: Array<[string, unknown]> = [];
      const predicates: Array<(row: Row) => boolean> = [];
      let indexFields: string[] | undefined;
      let direction: "asc" | "desc" = "asc";
      const ordered = () => {
        const matched = (tables[table] ?? []).filter(
          (row) => filters.every(([field, value]) => row[field] === value) && predicates.every((test) => test(row))
        );
        // Array.prototype.sort is stable, so rows with equal index fields keep creation order.
        const sorted = indexFields ? [...matched].sort(compareByFields(indexFields)) : matched;
        return direction === "desc" ? [...sorted].reverse() : sorted;
      };
      const builder = {
        withIndex(name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) {
          indexFields = indexes[table]?.[name];
          const q = {
            eq(field: string, value: unknown) {
              filters.push([field, value]);
              return q;
            },
          };
          build(q);
          return builder;
        },
        // Models `q.eq(q.field(name), value)` as the handlers use it; a field reference reads the row.
        filter(
          build: (q: { field: (name: string) => unknown; eq: (left: unknown, right: unknown) => boolean }) => unknown
        ) {
          predicates.push((row) => Boolean(build({ field: (name) => row[name], eq: (left, right) => left === right })));
          return builder;
        },
        order(next: "asc" | "desc") {
          direction = next;
          return builder;
        },
        take: async (count: number) => ordered().slice(0, count),
        first: async () => ordered()[0] ?? null,
        collect: async () => ordered(),
      };
      return builder;
    },
    get: async (id: string) => allRows().find((row) => row._id === id) ?? null,
    patch: async (id: string, fields: Record<string, unknown>) => {
      const row = allRows().find((candidate) => candidate._id === id);
      if (!row) {
        throw new Error(`patch: missing ${id}`);
      }
      Object.assign(row, fields);
    },
    insert: async (table: string, value: Record<string, unknown>) => {
      const _id = `${table}|${nextId++}`;
      tables[table] = [...(tables[table] ?? []), { _id, ...value }];
      return _id;
    },
    delete: async (id: string) => {
      for (const table of Object.keys(tables)) {
        tables[table] = (tables[table] ?? []).filter((row) => row._id !== id);
      }
    },
  };
  schedulers.set(db, scheduler);
  return db;
}

// Preserve the database-only contract for existing no-access trap fixtures.
export type Db = Omit<ReturnType<typeof createDb>, "scheduler" | "scheduled">;

export function createCtx(db: Db, subject: string | null) {
  return {
    db,
    get scheduler() {
      const scheduler = schedulers.get(db);
      if (scheduler === undefined) {
        throw new Error("No recorded scheduler for this database");
      }
      return scheduler;
    },
    auth: {
      getUserIdentity: async () => (subject ? { subject } : null),
    },
  };
}

// Convex registers each function with its handler on `_handler`; the public types omit it.
export type Handler<Args, Result> = (ctx: unknown, args: Args) => Promise<Result>;

export function handlerOf<Args, Result>(fn: unknown): Handler<Args, Result> {
  if (
    (typeof fn === "function" || typeof fn === "object") &&
    fn !== null &&
    "_handler" in fn &&
    typeof fn._handler === "function"
  ) {
    return fn._handler as Handler<Args, Result>;
  }
  throw new Error("Convex function has no handler");
}
