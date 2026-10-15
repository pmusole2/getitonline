import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-expo';
import { useConvexAuth, useMutation, useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import type { Id } from '../../../../convex/_generated/dataModel';

interface UploadedImage {
  /** The public Convex storage URL that can be accessed from anywhere */
  url: string;
  storageId: string;
  /** Local URI for preview purposes only - do not store in database */
  localUri?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  mimeType?: string;
}

interface ImageUploadValidationOptions {
  minWidth?: number;
  minHeight?: number;
  maxSizeBytes?: number;
  allowedMimeTypes?: readonly string[];
}

// Registration is attempted this many times in total. A file is usable only once its ownership row is written.
const REGISTRATION_ATTEMPTS = 2;

// The result of one upload. A cancelled upload left the screen, the subject, or Convex authentication it started under,
// so it writes nothing. A registration failure means the file is stored but has no owner, so its URL is never returned.
type UploadFailureReason = 'upload_failed' | 'registration_failed';

type UploadOutcome =
  | { readonly status: 'uploaded'; readonly image: UploadedImage }
  | { readonly status: 'failed'; readonly reason: UploadFailureReason }
  | { readonly status: 'cancelled' };

// The readiness generation a picker call or an upload started in. A later step is current only while it still matches.
interface UploadSession {
  readonly generation: number;
}

interface UseImageUploadReturn {
  images: UploadedImage[];
  isUploading: boolean;
  progress: number;
  validationErrors: string[];
  pickImages: (maxImages?: number, options?: ImageUploadValidationOptions) => Promise<void>;
  pickFromCamera: (maxImages?: number) => Promise<void>;
  removeImage: (index: number) => void;
  clearImages: () => void;
  /** Returns the public Convex storage URL */
  uploadSingleImage: (uri: string) => Promise<string | null>;
  /** Returns all public URLs from uploaded images */
  getImageUrls: () => string[];
}

export function useImageUpload(initialImages: UploadedImage[] = []): UseImageUploadReturn {
  const [images, setImages] = useState<UploadedImage[]>(initialImages);
  // The committed images, read synchronously. A pick reads the count here before it opens a picker, so the limit is checked
  // against the images that exist, not against a render that may already be stale.
  const imagesRef = useRef<UploadedImage[]>(initialImages);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const saveImageMetadata = useMutation(api.storage.saveImageMetadata);
  const convex = useConvex();
  const { userId } = useAuth();
  const convexAuth = useConvexAuth();

  // The subject uploads are bound to: the Clerk user, and only while Convex accepts the session. Losing either one ends
  // readiness, so an upload stops before its next external step.
  const readySubject = userId && convexAuth.isAuthenticated && !convexAuth.isLoading ? userId : null;

  // An upload checks these before each external step: the screen must still be mounted, and the readiness generation it
  // started in must still be current. Every change of readiness advances the generation, so an upload that started under
  // an earlier subject or session never continues into the next one.
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

  // The readiness generation a picker call or an upload started in. It is captured before the first await of the call, so
  // a result that arrives after the subject, the authentication, or the screen changed is recognised and dropped.
  const captureSession = (): UploadSession => ({ generation: generationRef.current });

  const replaceImages = (next: UploadedImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };

  // One picker-and-upload operation runs at a time. The lock is a ref, so it is taken synchronously, before the first await
  // of the operation: a second call that arrives while the first is in flight returns at once and opens no picker. It is
  // released in finally on every exit path (success, cancellation, a stale session, a denied permission, a cancelled
  // picker, a thrown error, and unmount). isUploading is set only when the operation starts its upload, and it clears
  // together with the lock, so it cannot end while another operation's upload is still running.
  const operationRef = useRef(false);

  const runExclusive = async (operation: (beginUpload: () => void) => Promise<void>): Promise<void> => {
    if (operationRef.current) return;
    operationRef.current = true;
    let uploading = false;
    try {
      await operation(() => {
        uploading = true;
        setIsUploading(true);
        setProgress(0);
      });
    } finally {
      operationRef.current = false;
      if (uploading && mountedRef.current) {
        setIsUploading(false);
        setProgress(0);
      }
    }
  };

  // A session is current while the screen is mounted, its generation is still current, and Convex readiness holds. A
  // stale session starts no work and sets no state.
  const isSessionCurrent = (session: UploadSession): boolean =>
    mountedRef.current && generationRef.current === session.generation && readySubjectRef.current !== null;

  const compressImage = async (uri: string): Promise<string> => {
    const result = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1200 } }], {
      compress: 0.8,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    return result.uri;
  };

  const uploadImage = async (
    session: UploadSession,
    uri: string,
    metadata?: Pick<UploadedImage, 'width' | 'height' | 'sizeBytes' | 'mimeType'>,
  ): Promise<UploadOutcome> => {
    const cancelled: UploadOutcome = { status: 'cancelled' };

    try {
      if (!isSessionCurrent(session)) return cancelled;
      // Compress image first
      const compressedUri = await compressImage(uri);

      if (!isSessionCurrent(session)) return cancelled;
      // Get upload URL from Convex
      const uploadUrl = await generateUploadUrl();

      if (!isSessionCurrent(session)) return cancelled;
      // Fetch the image as blob
      const response = await fetch(compressedUri);
      const blob = await response.blob();

      if (!isSessionCurrent(session)) return cancelled;
      // Upload to Convex storage
      const uploadResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'image/jpeg',
        },
        body: blob,
      });

      if (!uploadResponse.ok) {
        throw new Error('Upload failed');
      }

      const { storageId } = await uploadResponse.json();

      if (!isSessionCurrent(session)) return cancelled;
      // Record the signed-in owner, with the file public so it can be listed. The file is usable only once it is recorded:
      // a file with no ownership row resolves publicly and cannot be deleted by its uploader.
      let registered = false;
      for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS && !registered; attempt += 1) {
        try {
          await saveImageMetadata({
            storageId: storageId as Id<'_storage'>,
            fileName: compressedUri.split('/').pop() ?? 'image.jpg',
            contentType: blob.type || 'image/jpeg',
            size: blob.size,
            purpose: 'public',
          });
          registered = true;
        } catch {
          // The failure is reported once every attempt has failed, with its code and not its message.
        }
        if (!isSessionCurrent(session)) return cancelled;
      }
      if (!registered) {
        console.error('image_metadata_registration_failed');
        return { status: 'failed', reason: 'registration_failed' };
      }

      // Get the public URL from Convex storage
      const publicUrl = await convex.query(api.storage.getUrl, {
        storageId: storageId as Id<'_storage'>,
      });

      if (!isSessionCurrent(session)) return cancelled;
      if (!publicUrl) {
        throw new Error('Failed to get storage URL');
      }

      return {
        status: 'uploaded',
        image: {
          url: publicUrl,
          storageId,
          localUri: compressedUri,
          ...metadata,
        },
      };
    } catch {
      // A failure after the screen left or the readiness changed is expected, so it is not reported. Otherwise only the
      // fixed code is logged, never the error, whose message can carry internal text.
      if (!isSessionCurrent(session)) return cancelled;
      console.error('image_upload_failed');
      return { status: 'failed', reason: 'upload_failed' };
    }
  };

  const validateAsset = (asset: ImagePicker.ImagePickerAsset, options?: ImageUploadValidationOptions): string[] => {
    const errors: string[] = [];
    const label = asset.fileName ?? 'Selected image';
    const mimeType = asset.mimeType?.toLowerCase();

    if (options?.allowedMimeTypes && mimeType && !options.allowedMimeTypes.includes(mimeType)) {
      errors.push(`${label} must be a JPG or PNG image.`);
    }

    if (options?.maxSizeBytes && asset.fileSize && asset.fileSize > options.maxSizeBytes) {
      errors.push(`${label} is larger than ${Math.round(options.maxSizeBytes / 1024 / 1024)} MB.`);
    }

    if (options?.minWidth && asset.width < options.minWidth) {
      errors.push(`${label} must be at least ${options.minWidth}px wide.`);
    }

    if (options?.minHeight && asset.height < options.minHeight) {
      errors.push(`${label} must be at least ${options.minHeight}px tall.`);
    }

    return errors;
  };

  // Shows one message for the failed images of a pick, with their count. The message never includes the internal error.
  // When the picks failed for mixed reasons, the registration message is shown, since a retry is the user's next step either way.
  const reportFailedUploads = (reasons: readonly UploadFailureReason[]) => {
    if (reasons.length === 0) return;
    const reason = reasons.includes('registration_failed') ? 'registration_failed' : 'upload_failed';
    const noun = reasons.length === 1 ? 'image' : 'images';
    const action = reason === 'registration_failed' ? 'saved to your account' : 'uploaded';
    setValidationErrors([`${reasons.length} ${noun} could not be ${action}. Please try again.`]);
  };

  const pickImages = async (maxImages: number = 5, options?: ImageUploadValidationOptions) => {
    // The count is read before the lock: a call while an operation is in flight returns at once, and an operation can
    // add no more images than the slots left after the committed ones.
    const remaining = maxImages - imagesRef.current.length;
    if (remaining <= 0) return;

    await runExclusive(async (beginUpload) => {
      setValidationErrors([]);
      const session = captureSession();

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        selectionLimit: remaining,
      });

      // A result that arrives after the session ended is dropped silently: no state is set and nothing is uploaded.
      if (!isSessionCurrent(session)) return;
      if (result.canceled) return;

      // Only the slots that remain are taken, even when the picker returns more.
      const assets = result.assets.slice(0, remaining);
      const validationMessages = assets.flatMap((asset) => validateAsset(asset, options));
      if (validationMessages.length > 0) {
        setValidationErrors(validationMessages);
        return;
      }

      beginUpload();

      const uploadedImages: UploadedImage[] = [];
      const failedReasons: UploadFailureReason[] = [];
      const totalImages = assets.length;

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const outcome = await uploadImage(session, asset.uri, {
          width: asset.width,
          height: asset.height,
          sizeBytes: asset.fileSize,
          mimeType: asset.mimeType,
        });
        // A cancelled upload writes nothing for its subject; the lock's release ends the uploading state.
        if (outcome.status === 'cancelled') return;
        if (outcome.status === 'uploaded') {
          uploadedImages.push(outcome.image);
        } else {
          failedReasons.push(outcome.reason);
        }
        setProgress(((i + 1) / totalImages) * 100);
      }

      replaceImages([...imagesRef.current, ...uploadedImages]);
      reportFailedUploads(failedReasons);
    });
  };

  const pickFromCamera = async (maxImages: number = 5) => {
    if (imagesRef.current.length >= maxImages) return;

    await runExclusive(async (beginUpload) => {
      const session = captureSession();
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (!isSessionCurrent(session)) return;
      if (status !== 'granted') {
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });

      // A capture that arrives after the session ended is dropped silently, as a stale gallery result is.
      if (!isSessionCurrent(session)) return;
      if (result.canceled) return;
      setValidationErrors([]);

      beginUpload();

      const asset = result.assets[0];
      const outcome = await uploadImage(session, asset.uri, {
        width: asset.width,
        height: asset.height,
        sizeBytes: asset.fileSize,
        mimeType: asset.mimeType,
      });
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'uploaded') {
        replaceImages([...imagesRef.current, outcome.image]);
      } else {
        reportFailedUploads([outcome.reason]);
      }
    });
  };

  const uploadSingleImage = async (uri: string): Promise<string | null> => {
    const outcome = await uploadImage(captureSession(), uri);
    return outcome.status === 'uploaded' ? outcome.image.url || null : null;
  };

  const removeImage = (index: number) => {
    replaceImages(imagesRef.current.filter((_, i) => i !== index));
  };

  const clearImages = () => {
    replaceImages([]);
    setValidationErrors([]);
  };

  const getImageUrls = (): string[] => {
    return images.map((img) => img.url);
  };

  return {
    images,
    isUploading,
    progress,
    validationErrors,
    pickImages,
    pickFromCamera,
    removeImage,
    clearImages,
    uploadSingleImage,
    getImageUrls,
  };
}
