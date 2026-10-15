import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useConvex, useConvexAuth, useMutation } from "convex/react";

import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";

// Registration is attempted this many times in total. A file is usable only once its ownership row is written, because an
// unregistered file resolves publicly and cannot be deleted by its uploader.
const REGISTRATION_ATTEMPTS = 2;

export type StorageUploadFailure =
  | "upload_failed"
  | "registration_failed"
  | "url_unavailable";

// The result of one upload. A cancelled upload stopped because its mount, its signed-in subject, or its Convex session
// changed, so it made no later request and changes no state.
export type StorageUploadOutcome =
  | {
      readonly status: "uploaded";
      readonly storageId: Id<"_storage">;
      readonly url: string;
    }
  | { readonly status: "failed"; readonly reason: StorageUploadFailure }
  | { readonly status: "cancelled" };

export interface StorageUploadResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface StorageRegistration {
  readonly storageId: Id<"_storage">;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly purpose: "public";
}

// The external steps of an upload, each one a request the pipeline may make. isCurrent reports whether the upload may
// still act. The pipeline asks it after every await, so a stopped upload makes no further request.
export interface StorageUploadDeps {
  generateUploadUrl(): Promise<string>;
  send(uploadUrl: string, file: File): Promise<StorageUploadResponse>;
  saveImageMetadata(args: StorageRegistration): Promise<unknown>;
  getUrl(storageId: Id<"_storage">): Promise<string | null>;
  isCurrent(): boolean;
}

const CANCELLED: StorageUploadOutcome = { status: "cancelled" };

function readStorageId(receipt: unknown): Id<"_storage"> | null {
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("storageId" in receipt)
  ) {
    return null;
  }
  const { storageId } = receipt;
  // Convex ids are strings at runtime. The receipt is checked here, so the id is only ever a value the storage returned.
  return typeof storageId === "string" ? (storageId as Id<"_storage">) : null;
}

// Uploads a file and returns its URL only after the file is registered to the signed-in owner. The registration result
// is the gate: a file whose registration fails is never handed out.
export async function uploadFileToStorage(
  file: File,
  deps: StorageUploadDeps,
): Promise<StorageUploadOutcome> {
  try {
    if (!deps.isCurrent()) return CANCELLED;
    const uploadUrl = await deps.generateUploadUrl();

    if (!deps.isCurrent()) return CANCELLED;
    const response = await deps.send(uploadUrl, file);

    if (!deps.isCurrent()) return CANCELLED;
    if (!response.ok) {
      return { status: "failed", reason: "upload_failed" };
    }
    const storageId = readStorageId(await response.json());
    if (!deps.isCurrent()) return CANCELLED;
    if (storageId === null) {
      return { status: "failed", reason: "upload_failed" };
    }

    let registered = false;
    for (
      let attempt = 0;
      attempt < REGISTRATION_ATTEMPTS && !registered;
      attempt += 1
    ) {
      try {
        await deps.saveImageMetadata({
          storageId,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          size: file.size,
          purpose: "public",
        });
        registered = true;
      } catch {
        // The failure is reported once every attempt has failed, with its code and not its message.
      }
      if (!deps.isCurrent()) return CANCELLED;
    }
    if (!registered) {
      console.error("image_metadata_registration_failed");
      return { status: "failed", reason: "registration_failed" };
    }

    const url = await deps.getUrl(storageId);
    if (!deps.isCurrent()) return CANCELLED;
    if (url === null) {
      return { status: "failed", reason: "url_unavailable" };
    }
    return { status: "uploaded", storageId, url };
  } catch (error) {
    if (!deps.isCurrent()) return CANCELLED;
    console.error(
      "storage_upload_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { status: "failed", reason: "upload_failed" };
  }
}

// The message shown for an upload that did not finish. Each outcome has its own text, so the user knows what to do.
export function storageUploadMessage(
  outcome: Exclude<StorageUploadOutcome, { status: "uploaded" }>,
): string {
  switch (outcome.status) {
    case "cancelled":
      return "The upload was cancelled. Choose the file again.";
    case "failed":
      switch (outcome.reason) {
        case "registration_failed":
          return "The file could not be saved to your account. Try again.";
        case "url_unavailable":
          return "The uploaded file is not available yet. Try again.";
        case "upload_failed":
          return "The file could not be uploaded. Try again.";
      }
  }
}

// Returns an upload function bound to the current readiness: the Clerk subject, with Convex accepting its session. Losing
// either one, or unmounting, advances the generation, so an upload that started earlier stops before its next request.
export function useStorageUpload(): (
  file: File,
) => Promise<StorageUploadOutcome> {
  const { userId } = useAuth();
  const convex = useConvex();
  const convexAuth = useConvexAuth();
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const saveImageMetadata = useMutation(api.storage.saveImageMetadata);

  const readySubject =
    userId && convexAuth.isAuthenticated && !convexAuth.isLoading
      ? userId
      : null;

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const readySubjectRef = useRef(readySubject);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    readySubjectRef.current = readySubject;
  }, [readySubject]);

  return useCallback(
    (file: File) => {
      const generation = generationRef.current;
      return uploadFileToStorage(file, {
        generateUploadUrl: () => generateUploadUrl(),
        send: (uploadUrl, body) =>
          fetch(uploadUrl, {
            method: "POST",
            headers: {
              "Content-Type": body.type || "application/octet-stream",
            },
            body,
          }),
        saveImageMetadata: (args) => saveImageMetadata(args),
        getUrl: (storageId) => convex.query(api.storage.getUrl, { storageId }),
        isCurrent: () =>
          mountedRef.current &&
          generationRef.current === generation &&
          readySubjectRef.current !== null,
      });
    },
    [convex, generateUploadUrl, saveImageMetadata],
  );
}
