/**
 * Category Seed Script
 *
 * This script seeds the initial categories into Convex.
 * Run by an operator against a deployment: npx convex run seed:seedAllCategories
 *
 * This is internal: no client, signed-in or anonymous, can call it. It seeds only an empty categories table.
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Initial setup only. Internal, so it has no client path and needs no caller identity.
export const seedAllCategories = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Check if categories already exist
    const existing = await ctx.db.query("categories").first();
    if (existing) {
      return { success: false, message: "Categories already seeded" };
    }

    const categoriesData = [
      {
        name: "Auto Parts",
        slug: "auto-parts",
        description: "Vehicle parts and components",
        subcategories: [
          { name: "Engine Parts", slug: "engine-parts", description: "Engine components and accessories" },
          { name: "Suspension", slug: "suspension", description: "Suspension systems and parts" },
          { name: "Brakes", slug: "brakes", description: "Brake systems and components" },
          { name: "Electrical", slug: "electrical", description: "Electrical systems and parts" },
          { name: "Body Parts", slug: "body-parts", description: "Vehicle body panels and parts" },
          { name: "Oils & Lubricants", slug: "oils-lubricants", description: "Engine oils, transmission fluids, and lubricants" },
          { name: "Filters", slug: "filters", description: "Air, oil, fuel, and cabin filters" },
          { name: "Transmission", slug: "transmission", description: "Transmission parts and components" },
          { name: "Exhaust", slug: "exhaust", description: "Exhaust systems and mufflers" },
          { name: "Cooling System", slug: "cooling-system", description: "Radiators, thermostats, and cooling parts" },
        ],
      },
      {
        name: "Car Accessories",
        slug: "car-accessories",
        description: "Vehicle accessories and add-ons",
        subcategories: [
          { name: "Interior", slug: "interior", description: "Interior accessories and upgrades" },
          { name: "Exterior", slug: "exterior", description: "Exterior accessories and styling" },
          { name: "Car Electronics", slug: "car-electronics", description: "Audio, GPS, and electronic accessories" },
          { name: "Car Care", slug: "car-care", description: "Cleaning and maintenance products" },
          { name: "Safety & Security", slug: "safety-security", description: "Alarms, locks, and safety equipment" },
        ],
      },
      {
        name: "Tech & Electronics",
        slug: "tech-electronics",
        description: "Technology and electronic devices",
        subcategories: [
          { name: "Phones", slug: "phones", description: "Mobile phones and smartphones" },
          { name: "Laptops", slug: "laptops", description: "Laptops and notebooks" },
          { name: "Tablets", slug: "tablets", description: "Tablets and e-readers" },
          { name: "Tech Accessories", slug: "tech-accessories", description: "Chargers, cases, and accessories" },
          { name: "Gaming", slug: "gaming", description: "Gaming consoles and accessories" },
          { name: "Audio", slug: "audio", description: "Headphones, speakers, and audio equipment" },
          { name: "Cameras", slug: "cameras", description: "Cameras and photography equipment" },
        ],
      },
      {
        name: "Home & Garden",
        slug: "home-garden",
        description: "Home improvement and garden items",
        subcategories: [
          { name: "Furniture", slug: "furniture", description: "Home and office furniture" },
          { name: "Appliances", slug: "appliances", description: "Home appliances" },
          { name: "Garden Tools", slug: "garden-tools", description: "Gardening equipment and tools" },
          { name: "Decor", slug: "decor", description: "Home decoration items" },
        ],
      },
      {
        name: "Fashion",
        slug: "fashion",
        description: "Clothing and fashion accessories",
        subcategories: [
          { name: "Men's Clothing", slug: "mens-clothing", description: "Men's apparel" },
          { name: "Women's Clothing", slug: "womens-clothing", description: "Women's apparel" },
          { name: "Shoes", slug: "shoes", description: "Footwear for all" },
          { name: "Accessories", slug: "fashion-accessories", description: "Bags, watches, jewelry" },
        ],
      },
      {
        name: "Sports & Outdoors",
        slug: "sports-outdoors",
        description: "Sports equipment and outdoor gear",
        subcategories: [
          { name: "Fitness", slug: "fitness", description: "Gym and fitness equipment" },
          { name: "Outdoor Gear", slug: "outdoor-gear", description: "Camping and hiking equipment" },
          { name: "Sports Equipment", slug: "sports-equipment", description: "Equipment for various sports" },
          { name: "Bicycles", slug: "bicycles", description: "Bikes and cycling accessories" },
        ],
      },
      {
        name: "Other",
        slug: "other",
        description: "Other items and miscellaneous",
        subcategories: [
          { name: "Books", slug: "books", description: "Books and educational materials" },
          { name: "Collectibles", slug: "collectibles", description: "Collectible items" },
          { name: "Musical Instruments", slug: "musical-instruments", description: "Instruments and music equipment" },
          { name: "Miscellaneous", slug: "miscellaneous", description: "Other items" },
        ],
      },
    ];

    const now = Date.now();
    let sortOrder = 0;
    let totalCategories = 0;
    let totalSubcategories = 0;

    for (const category of categoriesData) {
      const parentId = await ctx.db.insert("categories", {
        name: category.name,
        slug: category.slug,
        description: category.description,
        isActive: true,
        sortOrder: sortOrder++,
        createdAt: now,
        updatedAt: now,
      });
      totalCategories++;

      let subSortOrder = 0;
      for (const sub of category.subcategories) {
        await ctx.db.insert("categories", {
          name: sub.name,
          slug: sub.slug,
          description: sub.description,
          parentId,
          isActive: true,
          sortOrder: subSortOrder++,
          createdAt: now,
          updatedAt: now,
        });
        totalSubcategories++;
      }
    }

    return {
      success: true,
      message: `Seeded ${totalCategories} categories and ${totalSubcategories} subcategories`,
    };
  },
});

// Create initial admin user (run this first if no users exist)
export const createInitialAdmin = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    firstName: v.string(),
    lastName: v.string(),
  },
  handler: async (ctx, args) => {
    // Check if any admin exists
    const existingAdmin = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "admin"))
      .first();

    if (existingAdmin) {
      return { success: false, message: "Admin already exists", adminId: existingAdmin._id };
    }

    const adminId = await ctx.db.insert("users", {
      clerkId: args.clerkId,
      email: args.email,
      firstName: args.firstName,
      lastName: args.lastName,
      role: "admin",
      totalSales: 0,
      totalPurchases: 0,
      isVerified: true,
      isBanned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return { success: true, message: "Admin created", adminId };
  },
});
