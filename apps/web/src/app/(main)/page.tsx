"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES } from "@/lib/constants";
import { formatZMW } from "@gettitonline/shared";
import { useQuery } from "convex/react";
import {
  ArrowRight,
  Car,
  CheckCircle,
  ChevronRight,
  CreditCard,
  HeadphonesIcon,
  Laptop,
  MessageSquare,
  Package,
  Search,
  Shield,
  Sparkles,
  Star,
  TrendingUp,
  Truck,
  Users,
  Wrench,
  Zap
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../../convex/_generated/api";

const features = [
  {
    icon: Shield,
    title: "Secure Escrow",
    description:
      "Your payment is protected until you receive and approve your order",
  },
  {
    icon: Zap,
    title: "Fast Delivery",
    description: "Quick and reliable shipping across Zambia",
  },
  {
    icon: MessageSquare,
    title: "Direct Chat",
    description: "Communicate directly with sellers before you buy",
  },
  {
    icon: Sparkles,
    title: "AI Powered",
    description: "Smarter discovery and guided support across every order",
  },
];

const howItWorks = [
  {
    step: 1,
    title: "Browse & Discover",
    description: "Explore thousands of products from trusted sellers across Zambia",
    icon: Search,
  },
  {
    step: 2,
    title: "Secure Payment",
    description: "Pay safely through our escrow system - funds held until delivery",
    icon: CreditCard,
  },
  {
    step: 3,
    title: "Fast Delivery",
    description: "Seller ships your order with tracking for peace of mind",
    icon: Truck,
  },
  {
    step: 4,
    title: "Confirm & Release",
    description: "Approve the order and payment is released to the seller",
    icon: CheckCircle,
  },
];

const stats = [
  { value: "10K+", label: "Happy Customers", icon: Users },
  { value: "5K+", label: "Products Listed", icon: Package },
  { value: "K5M+", label: "Transactions", icon: TrendingUp },
  { value: "99%", label: "Satisfaction Rate", icon: Star },
];

const testimonials = [
  {
    name: "Chisomo M.",
    role: "Buyer",
    location: "Lusaka",
    avatar: "",
    content: "I ordered home essentials and a new pair of sneakers in one checkout. The escrow flow made the whole experience feel safe and polished.",
    rating: 5,
  },
  {
    name: "Joseph K.",
    role: "Seller",
    location: "Ndola",
    avatar: "",
    content: "My storefront started with accessories and now I sell across fashion and electronics. The secure payout flow gives me confidence every time.",
    rating: 5,
  },
  {
    name: "Grace N.",
    role: "Buyer",
    location: "Kitwe",
    avatar: "",
    content: "I found a gift, a phone accessory, and a few beauty items without hopping between stores. Support was fast when I needed help.",
    rating: 5,
  },
];

const categoryIcons: Record<string, React.ElementType> = {
  "auto-parts": Car,
  "car-accessories": Wrench,
  "tech-electronics": Laptop,
};

export default function HomePage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  // Get categories
  const categories = useQuery(api.categories.getParentCategories);

  // Get recent products
  const recentProducts = useQuery(api.products.getRecentProducts, { limit: 8 });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`${ROUTES.SEARCH}?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  return (
    <div className="flex flex-col">
      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-primary/10 via-background to-background py-20 lg:py-32">
        {/* Background Pattern */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#8882_1px,transparent_1px),linear-gradient(to_bottom,#8882_1px,transparent_1px)] bg-[size:14px_24px]" />
        </div>

        <div className="container">
          <div className="mx-auto max-w-4xl text-center">
            <Badge variant="secondary" className="mb-4 px-4 py-1.5">
              <Sparkles className="mr-1 h-3 w-3" />
              Zambia&apos;s trusted online store
            </Badge>
            <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
              Shop with{" "}
              <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                Complete Confidence
              </span>
            </h1>
            <p className="mb-8 text-lg text-muted-foreground lg:text-xl max-w-2xl mx-auto">
              Fashion, electronics, lifestyle essentials, and everyday finds in one
              secure storefront. Shop confidently with escrow that protects you
              until delivery is confirmed.
            </p>

            {/* Search Bar */}
            <form onSubmit={handleSearch} className="mx-auto flex max-w-xl gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  placeholder="Search for products..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-12 pl-10 text-base"
                />
              </div>
              <Button type="submit" size="lg" className="h-12 px-8">
                Search
              </Button>
            </form>

            {/* Quick Links */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <span className="text-sm text-muted-foreground">Popular:</span>
              {["Sneakers", "Phone Accessories", "Kitchen Essentials", "Beauty Picks"].map(
                (term) => (
                  <Button key={term} variant="link" size="sm" asChild>
                    <Link href={`${ROUTES.SEARCH}?q=${encodeURIComponent(term)}`}>
                      {term}
                    </Link>
                  </Button>
                )
              )}
            </div>

            {/* Trust Badges */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-green-600" />
                <span>Escrow Protected</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span>Official Storefront</span>
              </div>
              <div className="flex items-center gap-2">
                <HeadphonesIcon className="h-4 w-4 text-green-600" />
                <span>24/7 Support</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="border-y bg-muted/30 py-12">
        <div className="container">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                  <stat.icon className="h-6 w-6 text-primary" />
                </div>
                <div className="text-3xl font-bold">{stat.value}</div>
                <div className="text-sm text-muted-foreground">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-16 lg:py-24">
        <div className="container">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Badge variant="outline" className="mb-4">Why Choose Us</Badge>
            <h2 className="mb-4 text-3xl font-bold lg:text-4xl">
              Trade with Confidence
            </h2>
            <p className="text-lg text-muted-foreground">
              Gettitonline blends trusted storefronts, protected payments, and
              cleaner discovery so every order feels simple and secure.
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => (
              <Card key={feature.title} className="border-0 bg-muted/30 text-center">
                <CardContent className="pt-8 pb-6">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                    <feature.icon className="h-7 w-7 text-primary" />
                  </div>
                  <h3 className="mb-2 text-lg font-semibold">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {feature.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="bg-muted/30 py-16 lg:py-24">
        <div className="container">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Badge variant="outline" className="mb-4">Simple Process</Badge>
            <h2 className="mb-4 text-3xl font-bold lg:text-4xl">
              How It Works
            </h2>
            <p className="text-lg text-muted-foreground">
              Start buying or selling in minutes with our simple, secure process.
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {howItWorks.map((step, index) => (
              <div key={step.step} className="relative text-center">
                {/* Connector Line */}
                {index < howItWorks.length - 1 && (
                  <div className="absolute right-0 top-8 hidden h-0.5 w-full bg-border lg:block" style={{ left: '50%' }} />
                )}

                <div className="relative mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <span className="text-xl font-bold">{step.step}</span>
                </div>
                <h3 className="mb-2 text-lg font-semibold">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Categories Section */}
      <section className="py-16 lg:py-24">
        <div className="container">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold lg:text-3xl">
                Browse Categories
              </h2>
              <p className="text-muted-foreground">
                Explore what&apos;s trending across our storefronts
              </p>
            </div>
            <Button variant="ghost" asChild>
              <Link href={ROUTES.BROWSE}>
                View All
                <ChevronRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {categories === undefined ? (
              Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="overflow-hidden">
                  <CardContent className="p-6">
                    <Skeleton className="mb-4 h-12 w-12 rounded-lg" />
                    <Skeleton className="mb-2 h-5 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </CardContent>
                </Card>
              ))
            ) : (
              categories.map((category) => {
                const Icon = categoryIcons[category.slug] || Wrench;
                return (
                  <Link key={category._id} href={ROUTES.CATEGORY(category.slug)}>
                    <Card className="overflow-hidden transition-all hover:shadow-lg hover:border-primary/50">
                      <CardContent className="p-6">
                        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5">
                          <Icon className="h-7 w-7 text-primary" />
                        </div>
                        <h3 className="font-semibold text-lg">{category.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {category.description || "Browse products"}
                        </p>
                        <div className="mt-3 flex items-center text-sm text-primary">
                          Shop Now <ArrowRight className="ml-1 h-4 w-4" />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* Recent Products Section */}
      <section className="bg-muted/30 py-16 lg:py-24">
        <div className="container">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold lg:text-3xl">
                Recently Listed
              </h2>
              <p className="text-muted-foreground">
                Fresh arrivals just added to Gettitonline
              </p>
            </div>
            <Button variant="ghost" asChild>
              <Link href={ROUTES.BROWSE}>
                View All
                <ChevronRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {recentProducts === undefined ? (
              Array.from({ length: 8 }).map((_, i) => (
                <Card key={i} className="overflow-hidden">
                  <Skeleton className="aspect-square w-full" />
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-4 w-3/4" />
                    <Skeleton className="h-5 w-1/2" />
                  </CardContent>
                </Card>
              ))
            ) : (
              recentProducts.map((product) => (
                <Link key={product._id} href={ROUTES.PRODUCT(product._id)}>
                  <Card className="overflow-hidden transition-all hover:shadow-lg group">
                    <div className="aspect-square overflow-hidden bg-muted relative">
                      {product.images?.[0] ? (
                        <img
                          src={product.images[0]}
                          alt={product.title}
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center">
                          <Package className="h-12 w-12 text-muted-foreground/50" />
                        </div>
                      )}
                      <Badge className="absolute top-2 right-2" variant="secondary">
                        {product.condition === "new"
                          ? "New"
                          : product.condition === "like_new"
                          ? "Like New"
                          : product.condition === "good"
                          ? "Good"
                          : "Fair"}
                      </Badge>
                    </div>
                    <CardContent className="p-4">
                      <h3 className="line-clamp-1 font-medium">
                        {product.title}
                      </h3>
                      <p className="mt-1 text-lg font-bold text-primary">
                        {formatZMW(product.price)}
                      </p>
                      {product.location?.city && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          📍 {product.location.city}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Testimonials Section */}
      <section className="py-16 lg:py-24">
        <div className="container">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Badge variant="outline" className="mb-4">Testimonials</Badge>
            <h2 className="mb-4 text-3xl font-bold lg:text-4xl">
              Loved by Thousands
            </h2>
            <p className="text-lg text-muted-foreground">
              See what our community has to say about their experience.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {testimonials.map((testimonial, index) => (
              <Card key={index} className="relative">
                <CardContent className="pt-6">
                  {/* Stars */}
                  <div className="mb-4 flex gap-1">
                    {Array.from({ length: testimonial.rating }).map((_, i) => (
                      <Star key={i} className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                    ))}
                  </div>

                  <p className="mb-6 text-muted-foreground">
                    &quot;{testimonial.content}&quot;
                  </p>

                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarImage src={testimonial.avatar} />
                      <AvatarFallback>
                        {testimonial.name.split(' ').map(n => n[0]).join('')}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-semibold">{testimonial.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {testimonial.role} • {testimonial.location}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section - Store */}
      <section className="py-16 lg:py-24">
        <div className="container">
          <Card className="overflow-hidden border-0 bg-gradient-to-br from-primary to-primary/80">
            <CardContent className="grid gap-8 p-8 lg:grid-cols-2 lg:p-12 items-center">
              <div className="text-primary-foreground">
                <Badge variant="secondary" className="mb-4">Why Shoppers Choose Us</Badge>
                <h2 className="mb-4 text-3xl font-bold lg:text-4xl">
                  Everything You Need in One Trusted Store
                </h2>
                <p className="mb-6 text-primary-foreground/80 text-lg">
                  Discover curated products, secure checkout, and responsive
                  support from the official Gettitonline storefront.
                </p>
                <ul className="mb-8 space-y-3">
                  {[
                    "Official Gettitonline inventory",
                    "Secure escrow protects every order",
                    "Built-in shipping and tracking",
                    "Helpful AI shopping assistance",
                  ].map((item) => (
                    <li key={item} className="flex items-center gap-2">
                      <CheckCircle className="h-5 w-5 text-green-300" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <Button size="lg" variant="secondary" asChild>
                  <Link href={ROUTES.BROWSE}>
                    Start Shopping
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>

              <div className="hidden lg:flex justify-center">
                <div className="relative">
                  <div className="absolute -inset-4 bg-white/10 rounded-2xl blur-xl" />
                  <Card className="relative bg-white/10 backdrop-blur border-white/20">
                    <CardContent className="p-6 text-primary-foreground">
                      <div className="text-center mb-4">
                        <div className="text-4xl font-bold">K12,500</div>
                        <div className="text-primary-foreground/70">Popular Weekly Picks</div>
                      </div>
                      <div className="space-y-3 text-sm">
                        <div className="flex justify-between">
                          <span className="text-primary-foreground/70">Items Curated</span>
                          <span className="font-medium">42</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-primary-foreground/70">Delivery Success</span>
                          <span className="font-medium">98%</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-primary-foreground/70">Customer Rating</span>
                          <span className="font-medium flex items-center gap-1">
                            4.9 <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-muted/30 py-16 lg:py-24">
        <div className="container">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="mb-4 text-3xl font-bold lg:text-4xl">
              Ready to Get Started?
            </h2>
            <p className="mb-8 text-lg text-muted-foreground">
              Join shoppers across Zambia using Gettitonline to discover and buy with confidence.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" asChild>
                <Link href={ROUTES.BROWSE}>
                  Start Shopping
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href={ROUTES.SEARCH}>
                  Explore Categories
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
