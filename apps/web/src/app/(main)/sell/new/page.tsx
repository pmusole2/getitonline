"use client";

import { ChangeEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../../../../../../convex/_generated/api";
import { Id } from "../../../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Package,
  Plus,
  Trash2,
  ImagePlus,
  Loader2,
  X,
  AlertCircle,
} from "lucide-react";
import { ROUTES, CONDITION_DISPLAY_NAMES, ZAMBIAN_PROVINCES } from "@/lib/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  MIN_PRODUCT_IMAGE_COUNT,
  MAX_PRODUCT_IMAGE_COUNT,
  validateProductImageDimensions,
  validateProductImageFiles,
} from "@/lib/product-image-upload";
import { toast } from "sonner";
import { canManageListings } from "@/lib/roles";

interface ShippingOption {
  name: string;
  price: number;
  estimatedDays: string;
}

interface Specification {
  key: string;
  value: string;
}

interface VariantAttribute {
  name: string;
  values: string[];
}

interface VariantOverride {
  price?: string;
  stock?: string;
  status?: "active" | "inactive" | "out_of_stock";
  primaryImage?: string;
}

interface VariantCombination {
  id: string;
  sku: string;
  attributes: Array<{ name: string; value: string }>;
  price: number;
  stock: number;
  status: "active" | "inactive" | "out_of_stock";
  primaryImage?: string;
}

interface UploadedProductImage {
  id: string;
  fileName: string;
  status: "uploading" | "uploaded" | "failed";
  url?: string;
  storageId?: Id<"_storage">;
  error?: string;
}

const VARIANT_ATTRIBUTE_OPTIONS = ["Size", "Storage", "Color", "Material", "Style", "Capacity"];
const SUGGESTED_SPEC_FIELDS = [
  "Brand",
  "Power",
  "Smart Capability",
  "Warranty",
  "Non-Stick",
  "Model",
  "Generation",
  "What's in the box",
  "Dishwasher Safe",
  "Appliance Type",
  "Basic Colours",
  "Barcode",
];

function skuToken(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
}

function parseVariantValues(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[,\n|]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, 100);
}

function filterCategoryOptions<T extends { name: string }>(
  options: T[] | undefined,
  query: string
) {
  if (!options) return [];
  if (!query) return options;

  return options.filter((option) =>
    option.name.toLowerCase().includes(query)
  );
}

function buildVariantCombinations(
  attributes: VariantAttribute[],
  baseSku: string,
  basePrice: number,
  baseStock: number,
  primaryImage?: string,
  overrides: Record<string, VariantOverride> = {}
): VariantCombination[] {
  if (attributes.length === 0) return [];

  const combinations = attributes.reduce<Array<Array<{ name: string; value: string }>>>(
    (current, attribute) =>
      current.flatMap((combination) =>
        attribute.values.map((value) => [...combination, { name: attribute.name, value }])
      ),
    [[]]
  );

  return combinations.map((attributesForCombination) => {
    const id = attributesForCombination
      .map((attribute) => skuToken(attribute.value))
      .join("-");
    const override = overrides[id] ?? {};
    const stock = override.stock ? Number(override.stock) : baseStock;
    const status =
      override.status ?? (stock > 0 ? "active" : "out_of_stock");

    return {
      id,
      sku: [baseSku || "SKU", ...attributesForCombination.map((attribute) => attribute.value)]
        .map(skuToken)
        .filter(Boolean)
        .join("-"),
      attributes: attributesForCombination,
      price: override.price ? Number(override.price) : basePrice,
      stock: Number.isFinite(stock) ? Math.max(0, stock) : 0,
      status,
      primaryImage: override.primaryImage || primaryImage,
    };
  });
}

export default function CreateListingPage() {
  const router = useRouter();
  const { user, isSignedIn, isLoading: authLoading } = useAuth();
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : "skip"
  );
  const hasListingAccess = canManageListings(
    user?.role,
    vendorProfile?.status ?? null
  );
  const convex = useConvex();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [formData, setFormData] = useState({
    title: "",
    brand: "",
    sku: "",
    shortDescription: "",
    keyFeatures: "",
    description: "",
    price: "",
    compareAtPrice: "",
    categoryId: "",
    subcategoryId: "",
    classificationId: "",
    condition: "new" as "new" | "like_new" | "good" | "fair",
    quantity: "1",
    lowStockThreshold: "",
    availabilityStatus: "in_stock" as "in_stock" | "preorder",
    preorderExpectedShipDate: "",
    weightKg: "",
    countryOfOrigin: "",
    modelNumber: "",
    warrantyType: "none" as "manufacturer" | "seller" | "none",
    warrantyDurationDays: "",
    city: "",
    province: "",
    status: "pending_review" as "draft" | "pending_review",
  });
  const [images, setImages] = useState<UploadedProductImage[]>([]);
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([
    { name: "Standard Delivery", price: 0, estimatedDays: "3-5 days" },
  ]);
  const [specifications, setSpecifications] = useState<Specification[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [variantAttributeDraft, setVariantAttributeDraft] = useState({
    name: "Size",
    values: "",
  });
  const [variantAttributes, setVariantAttributes] = useState<VariantAttribute[]>([]);
  const [variantOverrides, setVariantOverrides] = useState<Record<string, VariantOverride>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [categorySearch, setCategorySearch] = useState("");

  // Get categories
  const categories = useQuery(api.categories.getParentCategories);

  // Get subcategories when category selected
  const subcategories = useQuery(
    api.categories.getSubcategories,
    formData.categoryId ? { parentId: formData.categoryId as Id<"categories"> } : "skip"
  );

  const classifications = useQuery(
    api.categories.getSubcategories,
    formData.subcategoryId
      ? { parentId: formData.subcategoryId as Id<"categories"> }
      : "skip"
  );

  // Mutations
  const createProduct = useMutation(api.products.createProduct);
  const generateUploadUrl = useMutation(api.storage.generateUploadUrl);
  const uploadedImageUrls = useMemo(
    () =>
      images
        .filter((image) => image.status === "uploaded" && image.url)
        .map((image) => image.url as string),
    [images]
  );
  const variantCombinations = useMemo(
    () =>
      buildVariantCombinations(
        variantAttributes,
        formData.sku,
        Number(formData.price) || 0,
        Number.parseInt(formData.quantity, 10) || 0,
        uploadedImageUrls[0],
        variantOverrides
      ),
    [formData.price, formData.quantity, formData.sku, uploadedImageUrls, variantAttributes, variantOverrides]
  );
  const normalizedCategorySearch = categorySearch.trim().toLowerCase();
  const filteredCategories = useMemo(
    () => filterCategoryOptions(categories, normalizedCategorySearch),
    [categories, normalizedCategorySearch]
  );
  const filteredSubcategories = useMemo(
    () => filterCategoryOptions(subcategories, normalizedCategorySearch),
    [normalizedCategorySearch, subcategories]
  );
  const filteredClassifications = useMemo(
    () => filterCategoryOptions(classifications, normalizedCategorySearch),
    [classifications, normalizedCategorySearch]
  );

  const validateForm = (asDraft: boolean): boolean => {
    const newErrors: Record<string, string> = {};
    const isSubmission = !asDraft;
    const uploadedImageUrls = images
      .filter((image) => image.status === "uploaded" && image.url)
      .map((image) => image.url as string);
    const keyFeatures = formData.keyFeatures
      .split("\n")
      .map((feature) => feature.trim())
      .filter(Boolean);
    if (!formData.title.trim()) {
      newErrors.title = "Title is required";
    } else if (formData.title.length < 5) {
      newErrors.title = "Title must be at least 5 characters";
    }

    if (!formData.description.trim()) {
      newErrors.description = "Description is required";
    } else if (isSubmission && formData.description.length < 50) {
      newErrors.description = "Description must be at least 50 characters";
    }

    if (isSubmission && !formData.brand.trim()) {
      newErrors.brand = "Brand is required";
    }

    if (isSubmission && !formData.sku.trim()) {
      newErrors.sku = "SKU is required";
    }

    if (isSubmission && formData.shortDescription.trim().length < 20) {
      newErrors.shortDescription = "Short description must be at least 20 characters";
    }

    if (isSubmission && (keyFeatures.length < 3 || keyFeatures.length > 5)) {
      newErrors.keyFeatures = "Add 3-5 key features";
    }

    if (!formData.price || parseFloat(formData.price) <= 0) {
      newErrors.price = "Please enter a valid price";
    }

    if (!formData.categoryId) {
      newErrors.categoryId = "Please select a category";
    }

    if (isSubmission && !formData.subcategoryId) {
      newErrors.subcategoryId = "Please select a subcategory";
    }

    if (isSubmission && !formData.classificationId) {
      newErrors.classificationId = "Please select a classification";
    }

    if (isSubmission && uploadedImageUrls.length < MIN_PRODUCT_IMAGE_COUNT) {
      newErrors.images = `Please add at least ${MIN_PRODUCT_IMAGE_COUNT} images`;
    }

    if (images.some((image) => image.status === "uploading")) {
      newErrors.images = "Please wait for image uploads to finish";
    }

    if (parseInt(formData.quantity) < 1) {
      newErrors.quantity = "Quantity must be at least 1";
    }

    if (
      formData.lowStockThreshold &&
      parseInt(formData.lowStockThreshold) >= parseInt(formData.quantity)
    ) {
      newErrors.lowStockThreshold = "Low-stock threshold must be lower than quantity";
    }

    if (
      isSubmission &&
      formData.availabilityStatus === "preorder" &&
      !formData.preorderExpectedShipDate
    ) {
      newErrors.preorderExpectedShipDate = "Expected ship date is required for preorder items";
    }

    // Validate shipping options
    const validShipping = shippingOptions.filter(
      (opt) => opt.name.trim() && opt.estimatedDays.trim()
    );
    if (validShipping.length === 0) {
      newErrors.shipping = "Please add at least one shipping option";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (asDraft = false) => {
    if (!user) {
      toast.error("Please sign in to create a listing");
      return;
    }

    if (!validateForm(asDraft)) {
      toast.error("Please fix the errors before submitting");
      return;
    }

    setIsSubmitting(true);

    try {
      const uploadedImageUrls = images
        .filter((image) => image.status === "uploaded" && image.url)
        .map((image) => image.url as string);
      const keyFeatures = formData.keyFeatures
        .split("\n")
        .map((feature) => feature.trim())
        .filter(Boolean);
      const validSpecifications = specifications.filter(
        (spec) => spec.key.trim() && spec.value.trim()
      );
      const lowStockThreshold = formData.lowStockThreshold
        ? parseInt(formData.lowStockThreshold)
        : undefined;
      const preorderExpectedShipDate =
        formData.preorderExpectedShipDate &&
        formData.availabilityStatus === "preorder"
          ? new Date(formData.preorderExpectedShipDate).getTime()
          : undefined;

      const productId = await createProduct({
        actorUserId: user._id,
        title: formData.title.trim(),
        brand: formData.brand.trim() || undefined,
        sku: formData.sku.trim() || undefined,
        shortDescription: formData.shortDescription.trim() || undefined,
        description: formData.description.trim(),
        keyFeatures: keyFeatures.length > 0 ? keyFeatures : undefined,
        price: parseFloat(formData.price),
        compareAtPrice: formData.compareAtPrice
          ? parseFloat(formData.compareAtPrice)
          : undefined,
        categoryId: formData.categoryId as Id<"categories">,
        subcategoryId: formData.subcategoryId
          ? (formData.subcategoryId as Id<"categories">)
          : undefined,
        classificationId: formData.classificationId
          ? (formData.classificationId as Id<"categories">)
          : undefined,
        images: uploadedImageUrls,
        condition: formData.condition,
        quantity: parseInt(formData.quantity),
        lowStockThreshold,
        availabilityStatus: formData.availabilityStatus,
        preorder:
          formData.availabilityStatus === "preorder"
            ? {
                isPreorder: true,
                expectedShipDate: preorderExpectedShipDate,
              }
            : undefined,
        weightKg: formData.weightKg ? parseFloat(formData.weightKg) : undefined,
        warranty: {
          type: formData.warrantyType,
          durationDays: formData.warrantyDurationDays
            ? parseInt(formData.warrantyDurationDays)
            : undefined,
        },
        countryOfOrigin: formData.countryOfOrigin.trim() || undefined,
        modelNumber: formData.modelNumber.trim() || undefined,
        specifications: validSpecifications,
        variantAttributes:
          variantAttributes.length > 0 ? variantAttributes : undefined,
        variantCombinations:
          variantCombinations.length > 0 ? variantCombinations : undefined,
        tags: tags.length > 0 ? tags : undefined,
        location:
          formData.city && formData.province
            ? { city: formData.city, province: formData.province }
            : undefined,
        shippingOptions: shippingOptions.filter(
          (opt) => opt.name.trim() && opt.estimatedDays.trim()
        ),
        status: asDraft ? "draft" : "pending_review",
      });

      toast.success(
        asDraft
          ? "Listing saved as draft"
          : "Listing submitted for review"
      );

      router.push(ROUTES.PRODUCT(productId));
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to create listing";
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const addShippingOption = () => {
    setShippingOptions([
      ...shippingOptions,
      { name: "", price: 0, estimatedDays: "" },
    ]);
  };

  const removeShippingOption = (index: number) => {
    if (shippingOptions.length > 1) {
      setShippingOptions(shippingOptions.filter((_, i) => i !== index));
    }
  };

  const updateShippingOption = (
    index: number,
    field: keyof ShippingOption,
    value: string | number
  ) => {
    const updated = [...shippingOptions];
    updated[index] = { ...updated[index], [field]: value };
    setShippingOptions(updated);
  };

  const addSpecification = () => {
    setSpecifications([...specifications, { key: "", value: "" }]);
  };

  const addSuggestedSpecification = (key: string) => {
    setSpecifications((current) => {
      const hasField = current.some(
        (spec) => spec.key.trim().toLowerCase() === key.toLowerCase()
      );
      if (hasField) return current;

      const firstEmptyIndex = current.findIndex(
        (spec) => !spec.key.trim() && !spec.value.trim()
      );
      if (firstEmptyIndex >= 0) {
        return current.map((spec, index) =>
          index === firstEmptyIndex ? { key, value: "" } : spec
        );
      }

      return [...current, { key, value: "" }];
    });
  };

  const removeSpecification = (index: number) => {
    setSpecifications(specifications.filter((_, i) => i !== index));
  };

  const updateSpecification = (
    index: number,
    field: keyof Specification,
    value: string
  ) => {
    const updated = [...specifications];
    updated[index] = { ...updated[index], [field]: value };
    setSpecifications(updated);
  };

  const addVariantAttribute = () => {
    const values = parseVariantValues(variantAttributeDraft.values);
    const name = variantAttributeDraft.name.trim();
    if (!name || values.length === 0) {
      toast.error("Choose a variant attribute and add at least one value");
      return;
    }

    setVariantAttributes((current) => {
      const withoutExisting = current.filter(
        (attribute) => attribute.name.toLowerCase() !== name.toLowerCase()
      );
      return [...withoutExisting, { name, values }];
    });
    setVariantAttributeDraft({ ...variantAttributeDraft, values: "" });
  };

  const removeVariantAttribute = (name: string) => {
    setVariantAttributes((current) =>
      current.filter((attribute) => attribute.name !== name)
    );
    setVariantOverrides({});
  };

  const updateVariantOverride = (
    combinationId: string,
    field: keyof VariantOverride,
    value: string
  ) => {
    setVariantOverrides((current) => ({
      ...current,
      [combinationId]: {
        ...(current[combinationId] ?? {}),
        [field]: value,
      },
    }));
  };

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag) && tags.length < 10) {
      setTags([...tags, tag]);
      setTagInput("");
    }
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  const clearImageError = () => {
    setErrors((currentErrors) => {
      if (!currentErrors.images) {
        return currentErrors;
      }

      const rest = { ...currentErrors };
      delete rest.images;
      return rest;
    });
  };

  const uploadImage = async (file: File, imageId: string) => {
    try {
      const uploadUrl = await generateUploadUrl();
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": file.type,
        },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error("Upload request failed");
      }

      const { storageId } = (await uploadResponse.json()) as {
        storageId: Id<"_storage">;
      };
      const publicUrl = await convex.query(api.storage.getUrl, { storageId });

      if (!publicUrl) {
        throw new Error("Unable to resolve the uploaded image URL");
      }

      setImages((currentImages) =>
        currentImages.map((image) =>
          image.id === imageId
            ? {
                ...image,
                status: "uploaded",
                storageId,
                url: publicUrl,
                error: undefined,
              }
            : image
        )
      );
      clearImageError();
      return true;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Image upload failed";

      setImages((currentImages) =>
        currentImages.map((image) =>
          image.id === imageId
            ? {
                ...image,
                status: "failed",
                error: message,
              }
            : image
        )
      );
      return false;
    }
  };

  const handleImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (selectedFiles.length === 0) {
      return;
    }

    const { acceptedFiles, errors: validationErrors } = validateProductImageFiles(
      selectedFiles,
      images.length
    );

    if (validationErrors.length > 0) {
      setErrors((currentErrors) => ({
        ...currentErrors,
        images: validationErrors[0],
      }));
      toast.error(validationErrors[0]);
    }

    if (acceptedFiles.length === 0) {
      return;
    }

    const inspectedFiles = await Promise.all(
      acceptedFiles.map(async (file) => ({
        file,
        error: await validateProductImageDimensions(file),
      }))
    );
    const dimensionErrors = inspectedFiles
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));
    const uploadableFiles = inspectedFiles
      .filter((result) => !result.error)
      .map((result) => result.file);

    if (dimensionErrors.length > 0) {
      setErrors((currentErrors) => ({
        ...currentErrors,
        images: dimensionErrors[0],
      }));
      toast.error(dimensionErrors[0]);
    }

    if (uploadableFiles.length === 0) {
      return;
    }

    setIsUploadingImages(true);

    let failedUploads = 0;

    for (const file of uploadableFiles) {
      const imageId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      setImages((currentImages) => [
        ...currentImages,
        {
          id: imageId,
          fileName: file.name,
          status: "uploading",
        },
      ]);

      const didUpload = await uploadImage(file, imageId);
      if (!didUpload) {
        failedUploads += 1;
      }
    }

    setIsUploadingImages(false);

    if (failedUploads > 0) {
      toast.error(
        `${failedUploads} image upload${failedUploads === 1 ? "" : "s"} failed. Successful uploads were kept.`
      );
    }
  };

  const removeImage = (index: number) => {
    setImages(images.filter((_, i) => i !== index));
  };

  // Not signed in
  if (!authLoading && !isSignedIn) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Create a Listing</h1>
        <p className="mt-2 text-muted-foreground">
          Please sign in to create a listing
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SIGN_IN}>Sign In</Link>
        </Button>
      </div>
    );
  }

  if (!authLoading && isSignedIn && !hasListingAccess) {
    return (
      <div className="container flex flex-col items-center justify-center py-16">
        <Package className="h-16 w-16 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">Listing Access Restricted</h1>
        <p className="mt-2 text-center text-muted-foreground">
          Apply as a vendor from the sell dashboard before creating listings.
        </p>
        <Button asChild className="mt-6">
          <Link href={ROUTES.SELL}>Open Sell Dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="container py-6">
      {/* Breadcrumb */}
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href={ROUTES.HOME}>Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href={ROUTES.SELL}>Catalog</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Create Listing</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <h1 className="mb-6 text-2xl font-bold">Create a New Listing</h1>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Form */}
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle>Basic Information</CardTitle>
              <CardDescription>
                Add the essential details about your product
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  placeholder="e.g., Honda Civic Front Brake Pads"
                  value={formData.title}
                  onChange={(e) =>
                    setFormData({ ...formData, title: e.target.value })
                  }
                  className={errors.title ? "border-destructive" : ""}
                />
                {errors.title && (
                  <p className="text-sm text-destructive">{errors.title}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="brand">Brand *</Label>
                  <Input
                    id="brand"
                    placeholder="e.g., Samsung, Nike, Getitonline"
                    value={formData.brand}
                    onChange={(e) =>
                      setFormData({ ...formData, brand: e.target.value })
                    }
                    className={errors.brand ? "border-destructive" : ""}
                  />
                  {errors.brand && (
                    <p className="text-sm text-destructive">{errors.brand}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="sku">SKU *</Label>
                  <Input
                    id="sku"
                    placeholder="Unique seller SKU"
                    value={formData.sku}
                    onChange={(e) =>
                      setFormData({ ...formData, sku: e.target.value })
                    }
                    className={errors.sku ? "border-destructive" : ""}
                  />
                  {errors.sku && (
                    <p className="text-sm text-destructive">{errors.sku}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="shortDescription">Short Description *</Label>
                <Input
                  id="shortDescription"
                  placeholder="One-line buyer-facing summary"
                  value={formData.shortDescription}
                  onChange={(e) =>
                    setFormData({ ...formData, shortDescription: e.target.value })
                  }
                  className={errors.shortDescription ? "border-destructive" : ""}
                />
                {errors.shortDescription && (
                  <p className="text-sm text-destructive">
                    {errors.shortDescription}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="keyFeatures">Key Features *</Label>
                <Textarea
                  id="keyFeatures"
                  placeholder="Add one feature per line"
                  value={formData.keyFeatures}
                  onChange={(e) =>
                    setFormData({ ...formData, keyFeatures: e.target.value })
                  }
                  rows={4}
                  className={errors.keyFeatures ? "border-destructive" : ""}
                />
                {errors.keyFeatures && (
                  <p className="text-sm text-destructive">{errors.keyFeatures}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description *</Label>
                <Textarea
                  id="description"
                  placeholder="Describe your product in detail. Include condition, features, and any relevant information buyers should know."
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                  rows={6}
                  className={errors.description ? "border-destructive" : ""}
                />
                {errors.description && (
                  <p className="text-sm text-destructive">{errors.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {formData.description.length}/2000 characters
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="categorySearch">Search Categories</Label>
                  <Input
                    id="categorySearch"
                    placeholder="Filter category, subcategory, or classification"
                    value={categorySearch}
                    onChange={(e) => setCategorySearch(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="category">Category *</Label>
                  <Select
                    value={formData.categoryId}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        categoryId: value,
                        subcategoryId: "",
                        classificationId: "",
                      })
                    }
                  >
                    <SelectTrigger className={errors.categoryId ? "border-destructive" : ""}>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredCategories.map((cat) => (
                        <SelectItem key={cat._id} value={cat._id}>
                          {cat.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.categoryId && (
                    <p className="text-sm text-destructive">{errors.categoryId}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="subcategory">Subcategory</Label>
                  <Select
                    value={formData.subcategoryId}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        subcategoryId: value,
                        classificationId: "",
                      })
                    }
                    disabled={!formData.categoryId || !subcategories?.length}
                  >
                    <SelectTrigger className={errors.subcategoryId ? "border-destructive" : ""}>
                      <SelectValue placeholder="Select subcategory" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredSubcategories.map((sub) => (
                        <SelectItem key={sub._id} value={sub._id}>
                          {sub.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.subcategoryId && (
                    <p className="text-sm text-destructive">{errors.subcategoryId}</p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="classification">Classification *</Label>
                <Select
                  value={formData.classificationId}
                  onValueChange={(value) =>
                    setFormData({ ...formData, classificationId: value })
                  }
                  disabled={!formData.subcategoryId || !classifications?.length}
                >
                  <SelectTrigger className={errors.classificationId ? "border-destructive" : ""}>
                    <SelectValue placeholder="Select classification" />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredClassifications.map((classification) => (
                      <SelectItem key={classification._id} value={classification._id}>
                        {classification.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.classificationId && (
                  <p className="text-sm text-destructive">{errors.classificationId}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Condition *</Label>
                <RadioGroup
                  value={formData.condition}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      condition: value as typeof formData.condition,
                    })
                  }
                  className="flex flex-wrap gap-4"
                >
                  {Object.entries(CONDITION_DISPLAY_NAMES).map(([value, label]) => (
                    <div key={value} className="flex items-center space-x-2">
                      <RadioGroupItem value={value} id={`condition-${value}`} />
                      <Label htmlFor={`condition-${value}`}>{label}</Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
            </CardContent>
          </Card>

          {/* Images */}
          <Card>
            <CardHeader>
              <CardTitle>Images</CardTitle>
              <CardDescription>
                Add 3-8 JPG or PNG photos. Each image must be at least 1000x1000 and under 5 MB.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {images.map((image, index) => (
                  <div key={index} className="relative group">
                    <div className="aspect-square overflow-hidden rounded-lg bg-muted">
                      {image.status === "uploaded" && image.url ? (
                        <img
                          src={image.url}
                          alt={`Product ${index + 1}`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center">
                          {image.status === "uploading" ? (
                            <>
                              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">
                                Uploading {image.fileName}
                              </span>
                            </>
                          ) : (
                            <>
                              <AlertCircle className="h-6 w-6 text-destructive" />
                              <span className="text-xs text-destructive">
                                {image.error || "Upload failed"}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="destructive"
                      type="button"
                      size="icon"
                      className="absolute top-2 right-2 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeImage(index)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                    {index === 0 && (
                      <span className="absolute bottom-2 left-2 text-xs bg-black/70 text-white px-2 py-0.5 rounded">
                        Main
                      </span>
                    )}
                  </div>
                ))}

                {images.length < MAX_PRODUCT_IMAGE_COUNT && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png"
                      multiple
                      className="hidden"
                      onChange={handleImageUpload}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploadingImages}
                      className="aspect-square rounded-lg border-2 border-dashed border-muted-foreground/25 hover:border-muted-foreground/50 flex flex-col items-center justify-center gap-2 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isUploadingImages ? (
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                      ) : (
                        <ImagePlus className="h-8 w-8 text-muted-foreground" />
                      )}
                      <span className="text-xs text-muted-foreground">
                        {isUploadingImages ? "Uploading..." : "Add Photo"}
                      </span>
                    </button>
                  </>
                )}
              </div>
              {errors.images && (
                <p className="mt-2 text-sm text-destructive">{errors.images}</p>
              )}
            </CardContent>
          </Card>

          {/* Pricing */}
          <Card>
            <CardHeader>
              <CardTitle>Pricing & Inventory</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="price">Price (ZMW) *</Label>
                  <Input
                    id="price"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={formData.price}
                    onChange={(e) =>
                      setFormData({ ...formData, price: e.target.value })
                    }
                    className={errors.price ? "border-destructive" : ""}
                  />
                  {errors.price && (
                    <p className="text-sm text-destructive">{errors.price}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="compareAtPrice">Compare at Price</Label>
                  <Input
                    id="compareAtPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Original price"
                    value={formData.compareAtPrice}
                    onChange={(e) =>
                      setFormData({ ...formData, compareAtPrice: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">Optional, for showing discounts</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="quantity">Quantity *</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min="1"
                    value={formData.quantity}
                    onChange={(e) =>
                      setFormData({ ...formData, quantity: e.target.value })
                    }
                    className={errors.quantity ? "border-destructive" : ""}
                  />
                  {errors.quantity && (
                    <p className="text-sm text-destructive">{errors.quantity}</p>
                  )}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="lowStockThreshold">Low-stock Threshold</Label>
                  <Input
                    id="lowStockThreshold"
                    type="number"
                    min="0"
                    placeholder="e.g., 5"
                    value={formData.lowStockThreshold}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        lowStockThreshold: e.target.value,
                      })
                    }
                    className={errors.lowStockThreshold ? "border-destructive" : ""}
                  />
                  {errors.lowStockThreshold && (
                    <p className="text-sm text-destructive">
                      {errors.lowStockThreshold}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="availabilityStatus">Availability</Label>
                  <Select
                    value={formData.availabilityStatus}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        availabilityStatus: value as typeof formData.availabilityStatus,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select availability" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="in_stock">In stock</SelectItem>
                      <SelectItem value="preorder">Preorder</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="weightKg">Weight (kg)</Label>
                  <Input
                    id="weightKg"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="e.g., 1.25"
                    value={formData.weightKg}
                    onChange={(e) =>
                      setFormData({ ...formData, weightKg: e.target.value })
                    }
                  />
                </div>
              </div>

              {formData.availabilityStatus === "preorder" && (
                <div className="space-y-2">
                  <Label htmlFor="preorderExpectedShipDate">
                    Expected Ship Date *
                  </Label>
                  <Input
                    id="preorderExpectedShipDate"
                    type="date"
                    value={formData.preorderExpectedShipDate}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        preorderExpectedShipDate: e.target.value,
                      })
                    }
                    className={
                      errors.preorderExpectedShipDate ? "border-destructive" : ""
                    }
                  />
                  {errors.preorderExpectedShipDate && (
                    <p className="text-sm text-destructive">
                      {errors.preorderExpectedShipDate}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Shipping */}
          <Card>
            <CardHeader>
              <CardTitle>Shipping Options</CardTitle>
              <CardDescription>
                Define shipping methods and their costs
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {shippingOptions.map((option, index) => (
                <div key={index} className="flex gap-3 items-start">
                  <div className="flex-1 grid gap-3 sm:grid-cols-3">
                    <Input
                      placeholder="Shipping method"
                      value={option.name}
                      onChange={(e) =>
                        updateShippingOption(index, "name", e.target.value)
                      }
                    />
                    <Input
                      type="number"
                      min="0"
                      placeholder="Price (ZMW)"
                      value={option.price}
                      onChange={(e) =>
                        updateShippingOption(index, "price", parseFloat(e.target.value) || 0)
                      }
                    />
                    <Input
                      placeholder="Est. delivery (e.g., 3-5 days)"
                      value={option.estimatedDays}
                      onChange={(e) =>
                        updateShippingOption(index, "estimatedDays", e.target.value)
                      }
                    />
                  </div>
                  {shippingOptions.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeShippingOption(index)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
              {errors.shipping && (
                <p className="text-sm text-destructive">{errors.shipping}</p>
              )}
              <Button variant="outline" size="sm" onClick={addShippingOption}>
                <Plus className="mr-2 h-4 w-4" />
                Add Shipping Option
              </Button>
            </CardContent>
          </Card>

          {/* Location */}
          <Card>
            <CardHeader>
              <CardTitle>Location</CardTitle>
              <CardDescription>
                Where is the item located? (Optional)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    placeholder="e.g., Lusaka"
                    value={formData.city}
                    onChange={(e) =>
                      setFormData({ ...formData, city: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="province">Province</Label>
                  <Select
                    value={formData.province}
                    onValueChange={(value) =>
                      setFormData({ ...formData, province: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select province" />
                    </SelectTrigger>
                    <SelectContent>
                      {ZAMBIAN_PROVINCES.map((province) => (
                        <SelectItem key={province} value={province}>
                          {province}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Product Standards */}
          <Card>
            <CardHeader>
              <CardTitle>Product Standards</CardTitle>
              <CardDescription>
                Add warranty, origin, and model details for buyer confidence
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="countryOfOrigin">Country of Origin</Label>
                  <Input
                    id="countryOfOrigin"
                    placeholder="e.g., Zambia"
                    value={formData.countryOfOrigin}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        countryOfOrigin: e.target.value,
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="modelNumber">Model Number</Label>
                  <Input
                    id="modelNumber"
                    placeholder="Manufacturer model"
                    value={formData.modelNumber}
                    onChange={(e) =>
                      setFormData({ ...formData, modelNumber: e.target.value })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="warrantyType">Warranty</Label>
                  <Select
                    value={formData.warrantyType}
                    onValueChange={(value) =>
                      setFormData({
                        ...formData,
                        warrantyType: value as typeof formData.warrantyType,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select warranty" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No warranty</SelectItem>
                      <SelectItem value="seller">Seller warranty</SelectItem>
                      <SelectItem value="manufacturer">
                        Manufacturer warranty
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {formData.warrantyType !== "none" && (
                <div className="space-y-2">
                  <Label htmlFor="warrantyDurationDays">
                    Warranty Duration (days)
                  </Label>
                  <Input
                    id="warrantyDurationDays"
                    type="number"
                    min="1"
                    placeholder="e.g., 365"
                    value={formData.warrantyDurationDays}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        warrantyDurationDays: e.target.value,
                      })
                    }
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* Variants */}
          <Card>
            <CardHeader>
              <CardTitle>Variants</CardTitle>
              <CardDescription>
                Generate option combinations with per-variant price, stock, SKU, status, and image.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[180px_1fr_auto]">
                <Select
                  value={variantAttributeDraft.name}
                  onValueChange={(name) =>
                    setVariantAttributeDraft({ ...variantAttributeDraft, name })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Attribute" />
                  </SelectTrigger>
                  <SelectContent>
                    {VARIANT_ATTRIBUTE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={variantAttributeDraft.values}
                  onChange={(event) =>
                    setVariantAttributeDraft({
                      ...variantAttributeDraft,
                      values: event.target.value,
                    })
                  }
                  placeholder="Values separated by comma or pipe, e.g. 1|2|3 or Black, Silver"
                />
                <Button type="button" variant="outline" onClick={addVariantAttribute}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add
                </Button>
              </div>

              {variantAttributes.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {variantAttributes.map((attribute) => (
                    <span
                      key={attribute.name}
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-sm"
                    >
                      {attribute.name}: {attribute.values.join(", ")}
                      <button
                        type="button"
                        onClick={() => removeVariantAttribute(attribute.name)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {variantCombinations.length > 0 && (
                <div className="overflow-x-auto rounded-lg border">
                  <div className="grid min-w-[760px] grid-cols-[1.5fr_1fr_110px_110px_140px_1fr] gap-2 border-b bg-muted/40 p-3 text-xs font-medium uppercase text-muted-foreground">
                    <span>Combination</span>
                    <span>SKU</span>
                    <span>Price</span>
                    <span>Stock</span>
                    <span>Status</span>
                    <span>Image</span>
                  </div>
                  {variantCombinations.map((combination) => (
                    <div
                      key={combination.id}
                      className="grid min-w-[760px] grid-cols-[1.5fr_1fr_110px_110px_140px_1fr] gap-2 border-b p-3 last:border-b-0"
                    >
                      <span className="text-sm">
                        {combination.attributes
                          .map((attribute) => `${attribute.name}: ${attribute.value}`)
                          .join(" • ")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {combination.sku}
                      </span>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={variantOverrides[combination.id]?.price ?? String(combination.price)}
                        onChange={(event) =>
                          updateVariantOverride(combination.id, "price", event.target.value)
                        }
                      />
                      <Input
                        type="number"
                        min="0"
                        value={variantOverrides[combination.id]?.stock ?? String(combination.stock)}
                        onChange={(event) =>
                          updateVariantOverride(combination.id, "stock", event.target.value)
                        }
                      />
                      <Select
                        value={variantOverrides[combination.id]?.status ?? combination.status}
                        onValueChange={(status) =>
                          updateVariantOverride(combination.id, "status", status)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="inactive">Inactive</SelectItem>
                          <SelectItem value="out_of_stock">Out of stock</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select
                        value={variantOverrides[combination.id]?.primaryImage || combination.primaryImage || "default"}
                        onValueChange={(primaryImage) =>
                          updateVariantOverride(
                            combination.id,
                            "primaryImage",
                            primaryImage === "default" ? "" : primaryImage
                          )
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Default image" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default image</SelectItem>
                          {uploadedImageUrls.map((url, index) => (
                            <SelectItem key={url} value={url}>
                              Image {index + 1}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Specifications */}
          <Card>
            <CardHeader>
              <CardTitle>Specifications</CardTitle>
              <CardDescription>
                Add technical details about your product
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {SUGGESTED_SPEC_FIELDS.map((field) => (
                  <Button
                    key={field}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={specifications.some(
                      (spec) => spec.key.trim().toLowerCase() === field.toLowerCase()
                    )}
                    onClick={() => addSuggestedSpecification(field)}
                  >
                    {field}
                  </Button>
                ))}
              </div>
              {specifications.map((spec, index) => (
                <div key={index} className="flex gap-3 items-center">
                  <Input
                    placeholder="Specification name"
                    value={spec.key}
                    onChange={(e) =>
                      updateSpecification(index, "key", e.target.value)
                    }
                  />
                  <Input
                    placeholder="Value"
                    value={spec.value}
                    onChange={(e) =>
                      updateSpecification(index, "value", e.target.value)
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSpecification(index)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addSpecification}>
                <Plus className="mr-2 h-4 w-4" />
                Add Specification
              </Button>
              {errors.specifications && (
                <p className="text-sm text-destructive">{errors.specifications}</p>
              )}
            </CardContent>
          </Card>

          {/* Tags */}
          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
              <CardDescription>
                Add keywords to help buyers find your product (Optional)
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 mb-4">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-secondary text-sm"
                  >
                    {tag}
                    <button onClick={() => removeTag(tag)}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add a tag"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button variant="outline" onClick={addTag} disabled={tags.length >= 10}>
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {tags.length}/10 tags
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="lg:col-span-1">
          <Card className="sticky top-4">
            <CardHeader>
              <CardTitle>Publish Listing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted p-4">
                <p className="text-sm text-muted-foreground">
                  Your listing will be reviewed before going live. Make sure all
                  information is accurate.
                </p>
              </div>

              {Object.keys(errors).length > 0 && (
                <div className="rounded-lg bg-destructive/10 p-4 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
                  <p className="text-sm text-destructive">
                    Please fix the errors above before publishing
                  </p>
                </div>
              )}

              <Separator />

              <Button
                className="w-full"
                size="lg"
                onClick={() => handleSubmit(false)}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Publishing...
                  </>
                ) : (
                  "Publish Listing"
                )}
              </Button>

              <Button
                variant="outline"
                className="w-full"
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting}
              >
                Save as Draft
              </Button>

              <Button variant="ghost" className="w-full" asChild>
                <Link href={ROUTES.SELL}>Cancel</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
