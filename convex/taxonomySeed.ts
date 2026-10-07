import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";

type PrdTaxonomyL2 = {
  name: string;
  classifications: readonly string[];
};

type PrdTaxonomyL1 = {
  name: string;
  subcategories: readonly PrdTaxonomyL2[];
};

type ExpectedCategory = {
  name: string;
  slug: string;
  description: string;
  level: "l1" | "l2" | "l3";
  parentSlug?: string;
  sortOrder: number;
};

const PRD_RETAIL_TAXONOMY = [
  {
    name: "Electronics & Technology",
    subcategories: [
      { name: "Smartphones", classifications: ["Android Phones", "iPhones", "Feature Phones"] },
      { name: "Computers", classifications: ["Laptops", "Desktops", "Components"] },
      { name: "Accessories", classifications: ["Chargers", "Cables", "Power Banks"] },
      { name: "Audio", classifications: ["Headphones", "Speakers", "Microphones"] },
      { name: "Gaming", classifications: ["Consoles", "Games", "Accessories"] },
      { name: "Smart Devices", classifications: ["Smart Home", "Wearables"] },
    ],
  },
  {
    name: "Fashion & Apparel",
    subcategories: [
      { name: "Men", classifications: ["Clothing", "Shoes", "Accessories"] },
      { name: "Women", classifications: ["Clothing", "Shoes", "Accessories"] },
      { name: "Kids", classifications: ["Clothing", "Shoes"] },
      { name: "Luxury", classifications: ["Designer Wear", "Premium Accessories"] },
    ],
  },
  {
    name: "Home & Living",
    subcategories: [
      { name: "Furniture", classifications: ["Living Room", "Bedroom", "Office"] },
      { name: "Kitchen", classifications: ["Cookware", "Utensils", "Appliances"] },
      { name: "Decor", classifications: ["Wall Art", "Lighting", "Rugs"] },
      { name: "Storage", classifications: ["Cabinets", "Shelves"] },
    ],
  },
  {
    name: "Beauty & Personal Care",
    subcategories: [
      { name: "Skincare", classifications: ["Face Care", "Body Care"] },
      { name: "Haircare", classifications: ["Shampoo", "Styling"] },
      { name: "Makeup", classifications: ["Foundation", "Lipsticks"] },
      { name: "Grooming", classifications: ["Men's Grooming", "Tools"] },
    ],
  },
  {
    name: "Food & Groceries",
    subcategories: [
      { name: "Fresh Food", classifications: ["Fruits", "Vegetables"] },
      { name: "Packaged Food", classifications: ["Snacks", "Canned Goods"] },
      { name: "Beverages", classifications: ["Soft Drinks", "Juice", "Water"] },
      { name: "Specialty", classifications: ["Organic", "Imported"] },
    ],
  },
  {
    name: "Health & Wellness",
    subcategories: [
      { name: "Supplements", classifications: ["Vitamins", "Protein"] },
      { name: "Medical", classifications: ["Devices", "Equipment"] },
      { name: "Fitness", classifications: ["Gym Equipment", "Yoga"] },
    ],
  },
  {
    name: "Sports & Outdoors",
    subcategories: [
      { name: "Fitness", classifications: ["Gym Gear", "Accessories"] },
      { name: "Outdoor", classifications: ["Camping", "Hiking"] },
      { name: "Sports", classifications: ["Football", "Basketball"] },
    ],
  },
  {
    name: "Automotive",
    subcategories: [
      { name: "Parts", classifications: ["Engine Parts", "Tyres"] },
      { name: "Accessories", classifications: ["Interior", "Exterior"] },
      { name: "Tools", classifications: ["Repair Tools"] },
    ],
  },
  {
    name: "Books & Media",
    subcategories: [
      { name: "Books", classifications: ["Motivation", "Novel", "Academic"] },
      { name: "Music", classifications: ["Albums", "Digital Music"] },
      { name: "Movies", classifications: ["DVDs", "Digital"] },
    ],
  },
  {
    name: "Office & Stationery",
    subcategories: [
      { name: "Writing", classifications: ["Pens", "Pencils"] },
      { name: "Paper", classifications: ["Notebooks", "Printing Paper"] },
      { name: "Equipment", classifications: ["Printers", "Chairs"] },
    ],
  },
  {
    name: "Baby & Maternity",
    subcategories: [
      { name: "Baby Care", classifications: ["Diapers", "Feeding"] },
      { name: "Clothing", classifications: ["Baby Wear"] },
      { name: "Gear", classifications: ["Strollers", "Monitors"] },
    ],
  },
  {
    name: "Pet Supplies",
    subcategories: [
      { name: "Food", classifications: ["Dog", "Cat"] },
      { name: "Accessories", classifications: ["Toys", "Beds"] },
      { name: "Health", classifications: ["Grooming", "Medical"] },
    ],
  },
  {
    name: "Garden & Outdoors",
    subcategories: [
      { name: "Plants", classifications: ["Indoor", "Outdoor"] },
      { name: "Tools", classifications: ["Gardening Tools"] },
      { name: "Outdoor", classifications: ["Furniture", "BBQ"] },
    ],
  },
  {
    name: "Jewellery & Accessories",
    subcategories: [
      { name: "Jewellery", classifications: ["Rings", "Necklaces"] },
      { name: "Watches", classifications: ["Smart", "Classic"] },
      { name: "Fashion Accessories", classifications: ["Sunglasses", "Bags"] },
    ],
  },
  {
    name: "Arts & Crafts",
    subcategories: [
      { name: "Drawing", classifications: ["Pencils", "Paint"] },
      { name: "DIY", classifications: ["Craft Kits"] },
      { name: "Sewing", classifications: ["Materials", "Machines"] },
    ],
  },
  {
    name: "Industrial & Tools",
    subcategories: [
      { name: "Power Tools", classifications: ["Drills", "Saws"] },
      { name: "Safety", classifications: ["PPE Equipment"] },
      { name: "Hardware", classifications: ["Fasteners", "Electrical"] },
    ],
  },
  {
    name: "Travel & Luggage",
    subcategories: [
      { name: "Bags", classifications: ["Suitcases", "Backpacks"] },
      { name: "Accessories", classifications: ["Travel Kits"] },
      { name: "Security", classifications: ["Locks", "Trackers"] },
    ],
  },
  {
    name: "Digital Products",
    subcategories: [
      { name: "Software", classifications: ["Licenses"] },
      { name: "Content", classifications: ["eBooks", "Courses"] },
      { name: "Design", classifications: ["Templates"] },
    ],
  },
  {
    name: "Services",
    subcategories: [
      { name: "Home Services", classifications: ["Cleaning", "Repairs"] },
      { name: "Digital Services", classifications: ["Marketing", "Development"] },
      { name: "Subscriptions", classifications: ["Streaming", "Memberships"] },
    ],
  },
  {
    name: "Real Estate & Property",
    subcategories: [
      { name: "Residential", classifications: ["Houses", "Apartments"] },
      { name: "Commercial", classifications: ["Offices", "Shops"] },
      { name: "Land", classifications: ["Plots"] },
    ],
  },
  {
    name: "Education",
    subcategories: [
      { name: "Courses", classifications: ["Online Courses"] },
      { name: "Materials", classifications: ["Books", "Notes"] },
      { name: "Tutoring", classifications: ["Private Lessons"] },
    ],
  },
  {
    name: "Events & Tickets",
    subcategories: [
      { name: "Events", classifications: ["Concerts", "Conferences"] },
      { name: "Tickets", classifications: ["Digital Tickets"] },
    ],
  },
] as const satisfies readonly PrdTaxonomyL1[];

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildExpectedCategories() {
  const expected: ExpectedCategory[] = [];

  PRD_RETAIL_TAXONOMY.forEach((category, l1Index) => {
    const l1Slug = slugify(category.name);
    expected.push({
      name: category.name,
      slug: l1Slug,
      description: `${category.name} products and marketplace listings`,
      level: "l1",
      sortOrder: l1Index,
    });

    category.subcategories.forEach((subcategory, l2Index) => {
      const l2Slug = `${l1Slug}-${slugify(subcategory.name)}`;
      expected.push({
        name: subcategory.name,
        slug: l2Slug,
        description: `${subcategory.name} under ${category.name}`,
        level: "l2",
        parentSlug: l1Slug,
        sortOrder: l2Index,
      });

      subcategory.classifications.forEach((classification, l3Index) => {
        expected.push({
          name: classification,
          slug: `${l2Slug}-${slugify(classification)}`,
          description: `${classification} under ${subcategory.name}`,
          level: "l3",
          parentSlug: l2Slug,
          sortOrder: l3Index,
        });
      });
    });
  });

  return expected;
}

async function getApprovedByUserId(ctx: QueryCtx | MutationCtx, adminId?: Id<"users">) {
  if (adminId) {
    const admin = await ctx.db.get(adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: adminId must belong to an admin user");
    }
    return adminId;
  }

  const admin = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "admin"))
    .first();

  return admin?._id;
}

export const getPrdRetailTaxonomyStatus = query({
  args: {},
  handler: async (ctx) => {
    const expected = buildExpectedCategories();
    const categories = await ctx.db.query("categories").collect();
    const existingSlugs = new Set(categories.map((category) => category.slug));
    const missing = expected.filter((category) => !existingSlugs.has(category.slug));

    return {
      expected: {
        l1: expected.filter((category) => category.level === "l1").length,
        l2: expected.filter((category) => category.level === "l2").length,
        l3: expected.filter((category) => category.level === "l3").length,
        total: expected.length,
      },
      present: expected.length - missing.length,
      missing: missing.length,
      missingPreview: missing.slice(0, 20).map((category) => category.slug),
      totalActiveCategories: categories.filter((category) => category.isActive).length,
      totalCategories: categories.length,
    };
  },
});

export const seedPrdRetailTaxonomy = mutation({
  args: {
    adminId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const expected = buildExpectedCategories();
    const now = Date.now();
    const approvedByUserId = await getApprovedByUserId(ctx, args.adminId);
    const categories = await ctx.db.query("categories").collect();
    const bySlug = new Map(categories.map((category) => [category.slug, category]));
    const idsBySlug = new Map<string, Id<"categories">>();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    for (const category of expected) {
      const parentId = category.parentSlug ? idsBySlug.get(category.parentSlug) : undefined;
      if (category.parentSlug && !parentId) {
        throw new Error(`Parent category was not seeded before child: ${category.parentSlug}`);
      }

      const existing = bySlug.get(category.slug);
      if (!existing) {
        const categoryId = await ctx.db.insert("categories", {
          name: category.name,
          slug: category.slug,
          description: category.description,
          parentId,
          level: category.level,
          requiresApproval: false,
          approvedByUserId,
          approvedAt: approvedByUserId ? now : undefined,
          isActive: true,
          sortOrder: category.sortOrder,
          createdAt: now,
          updatedAt: now,
        });
        idsBySlug.set(category.slug, categoryId);
        inserted += 1;
        continue;
      }

      idsBySlug.set(category.slug, existing._id);
      const patch = {
        name: category.name,
        description: category.description,
        parentId,
        level: category.level,
        requiresApproval: false,
        approvedByUserId: existing.approvedByUserId ?? approvedByUserId,
        approvedAt: existing.approvedAt ?? (approvedByUserId ? now : undefined),
        isActive: true,
        sortOrder: category.sortOrder,
        updatedAt: now,
      };

      const needsUpdate =
        existing.name !== patch.name ||
        existing.description !== patch.description ||
        existing.parentId !== patch.parentId ||
        existing.level !== patch.level ||
        existing.requiresApproval !== patch.requiresApproval ||
        existing.approvedByUserId !== patch.approvedByUserId ||
        existing.approvedAt !== patch.approvedAt ||
        existing.isActive !== patch.isActive ||
        existing.sortOrder !== patch.sortOrder;

      if (needsUpdate) {
        await ctx.db.patch(existing._id, patch);
        updated += 1;
      } else {
        unchanged += 1;
      }
    }

    return {
      success: true,
      expected: {
        l1: expected.filter((category) => category.level === "l1").length,
        l2: expected.filter((category) => category.level === "l2").length,
        l3: expected.filter((category) => category.level === "l3").length,
        total: expected.length,
      },
      inserted,
      updated,
      unchanged,
    };
  },
});
