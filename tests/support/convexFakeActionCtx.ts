// In-memory Convex action context for handler tests. An action has no database of its own; it reaches data through
// runQuery and runMutation. This resolves each function reference to the handler exported by `modules` and runs it over
// the same fake db, so a test sees every read and write the action causes. `calls` records each run in order, so tests
// can assert that a reservation happens before a provider call.
//
// Every call is checked as the Convex runtime checks it. The arguments first go through the real serializer,
// `jsonToConvex(convexToJson(args))`, so anything `convexToJson` rejects (functions, Dates, Maps, undefined array
// elements, out-of-range bigints, reserved or malformed field names) fails before the handler runs. The round-tripped
// value is what the handler receives, so undefined object fields are dropped and bigints are decoded as in production.
// Then the value is matched against the function's argument validator. Convex serializes that validator with
// `exportArgs()`, and `validateArgs` walks that JSON. Literal values are decoded from their Convex JSON encoding before
// they are compared. It rejects unknown object fields, literals outside a union, malformed nested values, and missing
// required fields. A rejected call throws "Argument validation failed" and is not recorded in `calls`.
//
// Id convention: the fake db names each row `${table}|${n}` (see convexFakeDb's insert). An id validator accepts a
// string that starts with `${table}|` followed by something non-empty, so an id from another table is rejected.
// Validator kinds outside this list throw rather than pass, so a new validator cannot slip past the fake unchecked.

import { getFunctionName, type FunctionReference } from "convex/server";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";
import { createCtx, handlerOf, type Db } from "./convexFakeDb";

export type FakeModules = Record<string, Record<string, unknown>>;

export type FakeActionCtxOptions = {
  db: Db;
  subject: string | null;
  modules: FakeModules;
  calls?: string[];
};

type AnyReference = FunctionReference<"query" | "mutation", "public" | "internal">;

type RegisteredFunction = { exportArgs: () => string };

type JsonObject = { [key: string]: JSONValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isJsonObject(value: JSONValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegisteredFunction(value: unknown): value is RegisteredFunction {
  return (
    (typeof value === "function" || typeof value === "object") &&
    value !== null &&
    "exportArgs" in value &&
    typeof value.exportArgs === "function"
  );
}

// Reads a required key of a validator's JSON. A missing key means the validator is malformed.
function requireField(validator: JsonObject, key: string, path: string): JSONValue {
  const field = validator[key];
  if (field === undefined) {
    throw new Error(`Malformed validator at ${path}: missing ${key}`);
  }
  return field;
}

function unsupported(path: string, kind: unknown): never {
  throw new Error(`Unsupported validator ${String(kind)} at ${path}`);
}

// Returns why `value` does not match the JSON `validator`, or null when it matches. Throws on a malformed validator.
function mismatchOf(validator: JSONValue, value: unknown, path: string): string | null {
  if (!isJsonObject(validator)) {
    throw new Error(`Malformed validator at ${path}`);
  }
  const kind = validator.type;
  switch (kind) {
    case "any":
      return null;
    case "string":
      return typeof value === "string" ? null : `${path} must be a string`;
    // v.number() serializes as "number" and v.int64() as "bigint".
    case "number":
      return typeof value === "number" ? null : `${path} must be a number`;
    case "bigint":
      return typeof value === "bigint" ? null : `${path} must be a bigint`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    case "null":
      return value === null ? null : `${path} must be null`;
    case "bytes":
      return value instanceof ArrayBuffer ? null : `${path} must be bytes`;
    case "literal": {
      // The literal is stored in Convex JSON encoding (a bigint is {$integer: ...}), so decode it before comparing.
      const expected = jsonToConvex(requireField(validator, "value", path));
      return value === expected ? null : `${path} must equal ${String(expected)}`;
    }
    case "id": {
      const table = validator.tableName;
      if (typeof table !== "string") {
        unsupported(path, kind);
      }
      const prefix = `${table}|`;
      const valid = typeof value === "string" && value.startsWith(prefix) && value.length > prefix.length;
      return valid ? null : `${path} must be an id of table ${table}`;
    }
    case "array": {
      if (!isArray(value)) {
        return `${path} must be an array`;
      }
      const element = requireField(validator, "value", path);
      for (const [index, item] of value.entries()) {
        const mismatch = mismatchOf(element, item, `${path}[${index}]`);
        if (mismatch !== null) {
          return mismatch;
        }
      }
      return null;
    }
    case "record": {
      // v.record(keys, values) serializes as { keys, values: { fieldType, optional: false } }.
      if (!isRecord(value)) {
        return `${path} must be an object`;
      }
      const keys = requireField(validator, "keys", path);
      const values = requireField(validator, "values", path);
      if (!isJsonObject(values)) {
        unsupported(path, kind);
      }
      const fieldType = requireField(values, "fieldType", path);
      for (const [key, item] of Object.entries(value)) {
        const keyMismatch = mismatchOf(keys, key, `${path} key ${key}`);
        if (keyMismatch !== null) {
          return keyMismatch;
        }
        const itemMismatch = mismatchOf(fieldType, item, `${path}.${key}`);
        if (itemMismatch !== null) {
          return itemMismatch;
        }
      }
      return null;
    }
    case "object": {
      if (!isRecord(value)) {
        return `${path} must be an object`;
      }
      const fields = requireField(validator, "value", path);
      if (!isJsonObject(fields)) {
        unsupported(path, kind);
      }
      for (const [key, field] of Object.entries(fields)) {
        if (!isJsonObject(field)) {
          unsupported(path, kind);
        }
        const child = value[key];
        if (child === undefined) {
          if (field.optional === true) {
            continue;
          }
          return `${path}.${key} is required`;
        }
        const mismatch = mismatchOf(requireField(field, "fieldType", path), child, `${path}.${key}`);
        if (mismatch !== null) {
          return mismatch;
        }
      }
      // The serializer has already dropped undefined object fields, so every remaining key is a defined value.
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) {
          return `${path}.${key} is not a declared field`;
        }
      }
      return null;
    }
    case "union": {
      const members = requireField(validator, "value", path);
      if (!Array.isArray(members)) {
        unsupported(path, kind);
      }
      const accepted = members.some((member) => mismatchOf(member, value, path) === null);
      return accepted ? null : `${path} matches none of the allowed variants`;
    }
    default:
      return unsupported(path, kind);
  }
}

// Serializes the arguments the way the Convex client and runtime do. A value the serializer rejects is an argument
// validation failure, so it never reaches the validator or the handler.
function serializeArgs(args: unknown, name: string): Value {
  try {
    // Callers pass whatever a test supplies; the serializer is the check on it, so the cast marks that boundary.
    return jsonToConvex(convexToJson(args as Value));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Argument validation failed for ${name}: ${reason}`);
  }
}

// Throws when `args` does not match the registered function's argument validator. Returns the serialized arguments that
// the handler must receive.
export function validateArgs(fn: unknown, args: unknown, name: string): Value {
  if (!isRegisteredFunction(fn)) {
    throw new Error(`${name} has no argument validator`);
  }
  const validator: JSONValue = JSON.parse(fn.exportArgs());
  const serialized = serializeArgs(args, name);
  const mismatch = mismatchOf(validator, serialized, "args");
  if (mismatch !== null) {
    throw new Error(`Argument validation failed for ${name}: ${mismatch}`);
  }
  return serialized;
}

// Invokes a registered action the way the runtime does: validate the arguments, then run the handler.
export async function invokeFakeFunction(fn: unknown, ctx: unknown, args: unknown): Promise<unknown> {
  const checked = validateArgs(fn, args, "function");
  return await handlerOf<unknown, unknown>(fn)(ctx, checked);
}

function resolveExport(modules: FakeModules, name: string): unknown {
  const separator = name.lastIndexOf(":");
  const moduleName = name.slice(0, separator);
  const exportName = name.slice(separator + 1);
  const fn = modules[moduleName]?.[exportName];
  if (fn === undefined) {
    throw new Error(`No fake handler registered for ${name}`);
  }
  return fn;
}

export function createFakeActionCtx({ db, subject, modules, calls = [] }: FakeActionCtxOptions) {
  async function run(kind: "query" | "mutation", reference: AnyReference, args: unknown): Promise<unknown> {
    const name = getFunctionName(reference);
    const fn = resolveExport(modules, name);
    const checked = validateArgs(fn, args, name);
    calls.push(`${kind}:${name}`);
    return await handlerOf<unknown, unknown>(fn)(createCtx(db, subject), checked);
  }

  return {
    calls,
    auth: {
      getUserIdentity: async () => (subject ? { subject } : null),
    },
    runQuery: async (reference: AnyReference, args: unknown) => await run("query", reference, args),
    runMutation: async (reference: AnyReference, args: unknown) => await run("mutation", reference, args),
  };
}
