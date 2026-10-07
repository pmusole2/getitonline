import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Get all parent categories (no parentId)
export const getParentCategories = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("categories")
      .withIndex("by_parent", (q) => q.eq("parentId", undefined))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
  },
});

// Get all categories (including inactive, for admin)
export const getAllCategories = query({
  args: {
    adminId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can view all categories");
    }

    return await ctx.db.query("categories").collect();
  },
});

// Get subcategories by parent ID
export const getSubcategories = query({
  args: { parentId: v.id("categories") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("categories")
      .withIndex("by_parent", (q) => q.eq("parentId", args.parentId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
  },
});

// Get category by slug
export const getCategoryBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("categories")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

// Get category by ID
export const getCategory = query({
  args: { categoryId: v.id("categories") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.categoryId);
  },
});

// Get category with subcategories
export const getCategoryWithSubcategories = query({
  args: { categoryId: v.id("categories") },
  handler: async (ctx, args) => {
    const category = await ctx.db.get(args.categoryId);
    if (!category) return null;

    const subcategories = await ctx.db
      .query("categories")
      .withIndex("by_parent", (q) => q.eq("parentId", args.categoryId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    const subcategoryIds = new Set(subcategories.map((subcategory) => subcategory._id));
    const classifications = await ctx.db
      .query("categories")
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    return {
      ...category,
      subcategories: subcategories.map((subcategory) => ({
        ...subcategory,
        classifications: classifications
          .filter((classification) => classification.parentId === subcategory._id)
          .filter((classification) => subcategoryIds.has(classification.parentId!))
          .sort((a, b) => a.sortOrder - b.sortOrder),
      })),
    };
  },
});

// Get all categories with their subcategories (for navigation)
export const getCategoriesTree = query({
  args: {},
  handler: async (ctx) => {
    const allCategories = await ctx.db
      .query("categories")
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    // Get parent categories
    const parents = allCategories
      .filter((cat) => !cat.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // Build tree structure
    return parents.map((parent) => ({
      ...parent,
      subcategories: allCategories
        .filter((cat) => cat.parentId === parent._id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((subcategory) => ({
          ...subcategory,
          classifications: allCategories
            .filter((cat) => cat.parentId === subcategory._id)
            .sort((a, b) => a.sortOrder - b.sortOrder),
        })),
    }));
  },
});

// Create category (admin only)
export const createCategory = mutation({
  args: {
    adminId: v.id("users"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    parentId: v.optional(v.id("categories")),
    level: v.optional(v.union(v.literal("l1"), v.literal("l2"), v.literal("l3"))),
    requiresApproval: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can create categories");
    }

    // Check if slug already exists
    const existing = await ctx.db
      .query("categories")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();

    if (existing) {
      throw new Error("Category with this slug already exists");
    }

    const parent = args.parentId ? await ctx.db.get(args.parentId) : null;
    const level =
      args.level ??
      (parent?.level === "l2" ? "l3" : parent ? "l2" : "l1");

    return await ctx.db.insert("categories", {
      name: args.name,
      slug: args.slug,
      description: args.description,
      image: args.image,
      parentId: args.parentId,
      level,
      requiresApproval: args.requiresApproval ?? false,
      approvedByUserId: args.requiresApproval ? undefined : args.adminId,
      approvedAt: args.requiresApproval ? undefined : Date.now(),
      isActive: true,
      sortOrder: args.sortOrder ?? 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// Update category (admin only)
export const updateCategory = mutation({
  args: {
    adminId: v.id("users"),
    categoryId: v.id("categories"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    description: v.optional(v.string()),
    image: v.optional(v.string()),
    parentId: v.optional(v.id("categories")),
    level: v.optional(v.union(v.literal("l1"), v.literal("l2"), v.literal("l3"))),
    requiresApproval: v.optional(v.boolean()),
    isActive: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can update categories");
    }

    const { adminId, categoryId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined)
    );

    // If updating slug, check it doesn't already exist
    if (updates.slug) {
      const existing = await ctx.db
        .query("categories")
        .withIndex("by_slug", (q) => q.eq("slug", updates.slug!))
        .first();

      if (existing && existing._id !== categoryId) {
        throw new Error("Category with this slug already exists");
      }
    }

    await ctx.db.patch(categoryId, {
      ...filteredUpdates,
      updatedAt: Date.now(),
    });

    return await ctx.db.get(categoryId);
  },
});

// Delete category (admin only)
export const deleteCategory = mutation({
  args: {
    adminId: v.id("users"),
    categoryId: v.id("categories"),
  },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can delete categories");
    }

    // Check for subcategories
    const subcategories = await ctx.db
      .query("categories")
      .withIndex("by_parent", (q) => q.eq("parentId", args.categoryId))
      .first();

    if (subcategories) {
      throw new Error("Cannot delete category with subcategories");
    }

    // Check for products in this category
    const products = await ctx.db
      .query("products")
      .withIndex("by_category", (q) => q.eq("categoryId", args.categoryId))
      .first();

    if (products) {
      throw new Error("Cannot delete category with products");
    }

    await ctx.db.delete(args.categoryId);
  },
});

// Seed initial categories
export const seedCategories = mutation({
  args: { adminId: v.id("users") },
  handler: async (ctx, args) => {
    const admin = await ctx.db.get(args.adminId);
    if (!admin || admin.role !== "admin") {
      throw new Error("Unauthorized: Only admins can seed categories");
    }

    // Check if categories already exist
    const existing = await ctx.db.query("categories").first();
    if (existing) {
      throw new Error("Categories already seeded");
    }

    const categoriesData = [
      {
        name: "Electronics",
        slug: "electronics",
        description: "Phones, computers, gaming, audio, and connected devices",
        subcategories: [
          {
            name: "Mobile Phones",
            slug: "mobile-phones",
            description: "Smartphones, feature phones, and phone bundles",
            classifications: ["Android Phones", "iPhones", "Feature Phones", "Refurbished Phones"],
          },
          {
            name: "Computers",
            slug: "computers",
            description: "Laptops, desktops, monitors, and computer accessories",
            classifications: ["Laptops", "Desktop Computers", "Monitors", "Computer Accessories"],
          },
          {
            name: "TV & Audio",
            slug: "tv-audio",
            description: "Televisions, speakers, headphones, and home audio",
            classifications: ["Televisions", "Speakers", "Headphones", "Sound Bars"],
          },
          {
            name: "Gaming",
            slug: "gaming",
            description: "Consoles, games, controllers, and gaming accessories",
            classifications: ["Consoles", "Games", "Controllers", "Gaming Accessories"],
          },
        ],
      },
      {
        name: "Home & Kitchen",
        slug: "home-kitchen",
        description: "Furniture, appliances, kitchenware, and home essentials",
        subcategories: [
          {
            name: "Appliances",
            slug: "appliances",
            description: "Large and small appliances for the home",
            classifications: ["Refrigerators", "Cookers", "Microwaves", "Washing Machines"],
          },
          {
            name: "Furniture",
            slug: "furniture",
            description: "Living room, bedroom, office, and outdoor furniture",
            classifications: ["Sofas", "Beds", "Tables", "Office Furniture"],
          },
          {
            name: "Kitchen & Dining",
            slug: "kitchen-dining",
            description: "Cookware, dinnerware, storage, and kitchen tools",
            classifications: ["Cookware", "Dinnerware", "Kitchen Storage", "Kitchen Tools"],
          },
          {
            name: "Home Decor",
            slug: "home-decor",
            description: "Lighting, rugs, curtains, wall art, and decor",
            classifications: ["Lighting", "Rugs", "Curtains", "Wall Decor"],
          },
        ],
      },
      {
        name: "Fashion",
        slug: "fashion",
        description: "Clothing, shoes, bags, jewelry, and fashion accessories",
        subcategories: [
          {
            name: "Women",
            slug: "women-fashion",
            description: "Women's clothing, shoes, and accessories",
            classifications: ["Dresses", "Tops", "Shoes", "Bags"],
          },
          {
            name: "Men",
            slug: "men-fashion",
            description: "Men's clothing, shoes, and accessories",
            classifications: ["Shirts", "Trousers", "Shoes", "Watches"],
          },
          {
            name: "Kids",
            slug: "kids-fashion",
            description: "Children's clothing, footwear, and accessories",
            classifications: ["Girls Clothing", "Boys Clothing", "Kids Shoes", "School Wear"],
          },
          {
            name: "Jewelry & Accessories",
            slug: "jewelry-accessories",
            description: "Jewelry, watches, sunglasses, belts, and accessories",
            classifications: ["Jewelry", "Watches", "Sunglasses", "Belts"],
          },
        ],
      },
      {
        name: "Beauty & Personal Care",
        slug: "beauty-personal-care",
        description: "Beauty, grooming, fragrances, and personal care products",
        subcategories: [
          {
            name: "Skin Care",
            slug: "skin-care",
            description: "Cleansers, moisturizers, treatments, and sun care",
            classifications: ["Face Care", "Body Care", "Sun Care", "Treatments"],
          },
          {
            name: "Hair Care",
            slug: "hair-care",
            description: "Hair products, tools, extensions, and treatments",
            classifications: ["Shampoo", "Conditioner", "Hair Styling", "Hair Extensions"],
          },
          {
            name: "Makeup",
            slug: "makeup",
            description: "Face, eye, lip, and nail makeup",
            classifications: ["Face Makeup", "Eye Makeup", "Lip Makeup", "Nail Care"],
          },
          {
            name: "Fragrances",
            slug: "fragrances",
            description: "Perfumes, body sprays, and fragrance sets",
            classifications: ["Women's Fragrance", "Men's Fragrance", "Body Sprays", "Gift Sets"],
          },
        ],
      },
      {
        name: "Groceries & Household",
        slug: "groceries-household",
        description: "Food, beverages, cleaning supplies, and household essentials",
        subcategories: [
          {
            name: "Food Cupboard",
            slug: "food-cupboard",
            description: "Dry foods, canned goods, breakfast, and pantry staples",
            classifications: ["Cereals", "Rice & Pasta", "Canned Foods", "Baking"],
          },
          {
            name: "Beverages",
            slug: "beverages",
            description: "Water, juice, tea, coffee, and soft drinks",
            classifications: ["Water", "Juice", "Tea & Coffee", "Soft Drinks"],
          },
          {
            name: "Cleaning",
            slug: "cleaning",
            description: "Laundry, dishwashing, surface cleaners, and supplies",
            classifications: ["Laundry", "Dishwashing", "Surface Cleaners", "Cleaning Tools"],
          },
          {
            name: "Household Paper",
            slug: "household-paper",
            description: "Tissue, paper towels, wipes, and disposable goods",
            classifications: ["Toilet Tissue", "Paper Towels", "Wipes", "Disposable Goods"],
          },
        ],
      },
      {
        name: "Baby & Kids",
        slug: "baby-kids",
        description: "Baby care, toys, nursery, and children's products",
        subcategories: [
          {
            name: "Baby Care",
            slug: "baby-care",
            description: "Diapers, wipes, feeding, bath, and health products",
            classifications: ["Diapers", "Wipes", "Feeding", "Bath Care"],
          },
          {
            name: "Toys",
            slug: "toys",
            description: "Toys, games, learning products, and outdoor play",
            classifications: ["Educational Toys", "Action Toys", "Board Games", "Outdoor Play"],
          },
          {
            name: "Nursery",
            slug: "nursery",
            description: "Cots, bedding, monitors, and nursery furniture",
            classifications: ["Cots", "Bedding", "Baby Monitors", "Nursery Furniture"],
          },
        ],
      },
      {
        name: "Automotive",
        slug: "automotive",
        description: "Auto parts, accessories, oils, tools, and car care",
        subcategories: [
          {
            name: "Auto Parts",
            slug: "auto-parts",
            description: "Replacement parts and service components",
            classifications: ["Engine Parts", "Brakes", "Suspension", "Filters"],
          },
          {
            name: "Car Accessories",
            slug: "car-accessories",
            description: "Interior, exterior, electronics, and safety accessories",
            classifications: ["Interior Accessories", "Exterior Accessories", "Car Electronics", "Safety"],
          },
          {
            name: "Oils & Fluids",
            slug: "oils-fluids",
            description: "Engine oil, coolant, brake fluid, and lubricants",
            classifications: ["Engine Oil", "Coolant", "Brake Fluid", "Lubricants"],
          },
          {
            name: "Car Care",
            slug: "car-care",
            description: "Cleaning, detailing, waxes, and maintenance products",
            classifications: ["Cleaning", "Detailing", "Waxes", "Maintenance"],
          },
        ],
      },
      {
        name: "Tools & Hardware",
        slug: "tools-hardware",
        description: "Power tools, hand tools, building supplies, and hardware",
        subcategories: [
          {
            name: "Power Tools",
            slug: "power-tools",
            description: "Drills, saws, grinders, sanders, and power accessories",
            classifications: ["Drills", "Saws", "Grinders", "Tool Accessories"],
          },
          {
            name: "Hand Tools",
            slug: "hand-tools",
            description: "Hammers, screwdrivers, spanners, pliers, and tool sets",
            classifications: ["Hammers", "Screwdrivers", "Spanners", "Tool Sets"],
          },
          {
            name: "Building Supplies",
            slug: "building-supplies",
            description: "Paint, plumbing, electrical, and construction supplies",
            classifications: ["Paint", "Plumbing", "Electrical", "Construction"],
          },
        ],
      },
      {
        name: "Sports & Outdoors",
        slug: "sports-outdoors",
        description: "Fitness, sports equipment, outdoor gear, and travel products",
        subcategories: [
          {
            name: "Fitness",
            slug: "fitness",
            description: "Gym equipment, weights, yoga, and training gear",
            classifications: ["Weights", "Cardio", "Yoga", "Training Gear"],
          },
          {
            name: "Team Sports",
            slug: "team-sports",
            description: "Football, basketball, netball, and team equipment",
            classifications: ["Football", "Basketball", "Netball", "Team Equipment"],
          },
          {
            name: "Outdoor Recreation",
            slug: "outdoor-recreation",
            description: "Camping, hiking, fishing, and outdoor equipment",
            classifications: ["Camping", "Hiking", "Fishing", "Outdoor Gear"],
          },
        ],
      },
      {
        name: "Books, Office & Stationery",
        slug: "books-office-stationery",
        description: "Books, school supplies, office equipment, and stationery",
        subcategories: [
          {
            name: "Books",
            slug: "books",
            description: "Fiction, non-fiction, textbooks, and children's books",
            classifications: ["Fiction", "Non-fiction", "Textbooks", "Children's Books"],
          },
          {
            name: "Stationery",
            slug: "stationery",
            description: "Writing, paper, art supplies, and school essentials",
            classifications: ["Writing", "Paper", "Art Supplies", "School Supplies"],
          },
          {
            name: "Office Equipment",
            slug: "office-equipment",
            description: "Printers, chairs, desks, storage, and office supplies",
            classifications: ["Printers", "Office Chairs", "Desks", "Office Storage"],
          },
        ],
      },
      {
        name: "Health & Wellness",
        slug: "health-wellness",
        description: "Health devices, supplements, wellness, and personal safety",
        subcategories: [
          {
            name: "Health Devices",
            slug: "health-devices",
            description: "Monitors, thermometers, mobility aids, and health tools",
            classifications: ["Blood Pressure Monitors", "Thermometers", "Mobility Aids", "Health Tools"],
          },
          {
            name: "Vitamins & Supplements",
            slug: "vitamins-supplements",
            description: "Vitamins, minerals, protein, and wellness supplements",
            classifications: ["Vitamins", "Minerals", "Protein", "Wellness Supplements"],
          },
          {
            name: "Personal Safety",
            slug: "personal-safety",
            description: "Masks, sanitizers, first aid, and safety products",
            classifications: ["Masks", "Sanitizers", "First Aid", "Safety Products"],
          },
        ],
      },
    ];

    const now = Date.now();
    let sortOrder = 0;

    for (const category of categoriesData) {
      const parentId = await ctx.db.insert("categories", {
        name: category.name,
        slug: category.slug,
        description: category.description,
        level: "l1",
        requiresApproval: false,
        approvedByUserId: args.adminId,
        approvedAt: now,
        isActive: true,
        sortOrder: sortOrder++,
        createdAt: now,
        updatedAt: now,
      });

      let subSortOrder = 0;
      for (const sub of category.subcategories) {
        const subcategoryId = await ctx.db.insert("categories", {
          name: sub.name,
          slug: sub.slug,
          description: sub.description,
          parentId,
          level: "l2",
          requiresApproval: false,
          approvedByUserId: args.adminId,
          approvedAt: now,
          isActive: true,
          sortOrder: subSortOrder++,
          createdAt: now,
          updatedAt: now,
        });

        let classificationSortOrder = 0;
        for (const classification of sub.classifications) {
          await ctx.db.insert("categories", {
            name: classification,
            slug: `${sub.slug}-${classification
              .toLowerCase()
              .replace(/&/g, "and")
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")}`,
            parentId: subcategoryId,
            level: "l3",
            requiresApproval: false,
            approvedByUserId: args.adminId,
            approvedAt: now,
            isActive: true,
            sortOrder: classificationSortOrder++,
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    }

    return { success: true, message: "Categories seeded successfully" };
  },
});
