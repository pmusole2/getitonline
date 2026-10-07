import { useState } from 'react';
import { useMutation, useConvex } from 'convex/react';
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

interface UseImageUploadReturn {
  images: UploadedImage[];
  isUploading: boolean;
  progress: number;
  validationErrors: string[];
  pickImages: (maxImages?: number, options?: ImageUploadValidationOptions) => Promise<void>;
  pickFromCamera: () => Promise<void>;
  removeImage: (index: number) => void;
  clearImages: () => void;
  /** Returns the public Convex storage URL */
  uploadSingleImage: (uri: string) => Promise<string | null>;
  /** Returns all public URLs from uploaded images */
  getImageUrls: () => string[];
}

export function useImageUpload(initialImages: UploadedImage[] = []): UseImageUploadReturn {
  const [images, setImages] = useState<UploadedImage[]>(initialImages);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const convex = useConvex();

  const compressImage = async (uri: string): Promise<string> => {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 1200 } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  };

  const uploadImage = async (
    uri: string,
    metadata?: Pick<UploadedImage, 'width' | 'height' | 'sizeBytes' | 'mimeType'>,
  ): Promise<UploadedImage | null> => {
    try {
      // Compress image first
      const compressedUri = await compressImage(uri);

      // Get upload URL from Convex
      const uploadUrl = await generateUploadUrl();

      // Fetch the image as blob
      const response = await fetch(compressedUri);
      const blob = await response.blob();

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

      // Get the public URL from Convex storage
      const publicUrl = await convex.query(api.storage.getUrl, {
        storageId: storageId as Id<'_storage'>
      });

      if (!publicUrl) {
        throw new Error('Failed to get storage URL');
      }

      return {
        url: publicUrl,
        storageId,
        localUri: compressedUri,
        ...metadata,
      };
    } catch (error) {
      console.error('Error uploading image:', error);
      return null;
    }
  };

  const validateAsset = (
    asset: ImagePicker.ImagePickerAsset,
    options?: ImageUploadValidationOptions,
  ): string[] => {
    const errors: string[] = [];
    const label = asset.fileName ?? 'Selected image';
    const mimeType = asset.mimeType?.toLowerCase();

    if (
      options?.allowedMimeTypes &&
      mimeType &&
      !options.allowedMimeTypes.includes(mimeType)
    ) {
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

  const pickImages = async (maxImages: number = 5, options?: ImageUploadValidationOptions) => {
    const remaining = maxImages - images.length;
    if (remaining <= 0) return;
    setValidationErrors([]);

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.8,
      selectionLimit: remaining,
    });

    if (result.canceled) return;

    const validationMessages = result.assets.flatMap((asset) => validateAsset(asset, options));
    if (validationMessages.length > 0) {
      setValidationErrors(validationMessages);
      return;
    }

    setIsUploading(true);
    setProgress(0);

    const uploadedImages: UploadedImage[] = [];
    const totalImages = result.assets.length;

    for (let i = 0; i < result.assets.length; i++) {
      const asset = result.assets[i];
      const uploaded = await uploadImage(asset.uri, {
        width: asset.width,
        height: asset.height,
        sizeBytes: asset.fileSize,
        mimeType: asset.mimeType,
      });
      if (uploaded) {
        uploadedImages.push(uploaded);
      }
      setProgress(((i + 1) / totalImages) * 100);
    }

    setImages((prev) => [...prev, ...uploadedImages]);
    setIsUploading(false);
    setProgress(0);
  };

  const pickFromCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });

    if (result.canceled) return;
    setValidationErrors([]);

    setIsUploading(true);
    setProgress(0);

    const asset = result.assets[0];
    const uploaded = await uploadImage(asset.uri, {
      width: asset.width,
      height: asset.height,
      sizeBytes: asset.fileSize,
      mimeType: asset.mimeType,
    });
    if (uploaded) {
      setImages((prev) => [...prev, uploaded]);
    }

    setIsUploading(false);
    setProgress(0);
  };

  const uploadSingleImage = async (uri: string): Promise<string | null> => {
    const uploaded = await uploadImage(uri);
    return uploaded?.url || null;
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const clearImages = () => {
    setImages([]);
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
