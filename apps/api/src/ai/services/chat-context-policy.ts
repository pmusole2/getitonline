interface OrderActivitySummary {
  totalOrders: number;
  pendingOrders: number;
  completedOrders: number;
  disputedOrders: number;
}

interface SellerOrderActivity {
  status?: unknown;
  [key: string]: unknown;
}

interface ListingActivitySummary {
  totalListings: number;
  activeListings: number;
  soldListings: number;
  totalViews: number;
}

interface SafeAccountContextInput {
  orders?: OrderActivitySummary | null;
  sellerOrders?: SellerOrderActivity[] | null;
  listings?: ListingActivitySummary | null;
}

interface PublicProductContext {
  title: string;
  description: string;
  price: number;
  condition: string;
  views?: number;
  seller?: {
    rating?: number;
    [key: string]: unknown;
  } | null;
}

export function buildSafeAccountContext({
  orders,
  sellerOrders,
  listings,
}: SafeAccountContextInput): string {
  let context = '';

  if (orders) {
    context += `\n\n=== ACCOUNT ORDER ACTIVITY ===`;
    context += `\nTotal orders: ${orders.totalOrders}`;
    context += `\nPending: ${orders.pendingOrders}`;
    context += `\nCompleted: ${orders.completedOrders}`;
    context += `\nDisputed: ${orders.disputedOrders}`;
  }

  if (sellerOrders?.length) {
    const pending = sellerOrders.filter((order) =>
      ['paid', 'processing', 'shipped'].includes(String(order.status)),
    ).length;
    const completed = sellerOrders.filter((order) =>
      ['delivered', 'completed'].includes(String(order.status)),
    ).length;
    const disputed = sellerOrders.filter(
      (order) => order.status === 'disputed',
    ).length;

    context += `\n\n=== SELLER ORDER ACTIVITY ===`;
    context += `\nTotal orders received: ${sellerOrders.length}`;
    context += `\nPending fulfillment: ${pending}`;
    context += `\nCompleted sales: ${completed}`;
    context += `\nDisputed orders: ${disputed}`;
  }

  if (listings) {
    context += `\n\n=== LISTING ACTIVITY ===`;
    context += `\nTotal listings: ${listings.totalListings}`;
    context += `\nActive: ${listings.activeListings}`;
    context += `\nSold: ${listings.soldListings}`;
    context += `\nTotal views: ${listings.totalViews}`;
  }

  return context;
}

export function buildSafeProductContext(product: PublicProductContext): string {
  let context = `\n\n=== CURRENTLY VIEWING PRODUCT ===`;
  context += `\nTitle: ${product.title}`;
  context += `\nPrice: K${product.price.toLocaleString()}`;
  context += `\nCondition: ${product.condition}`;
  context += `\nDescription: ${product.description}`;
  context += `\nViews: ${product.views || 0}`;

  if (product.seller?.rating) {
    context += `\nSeller rating: ${product.seller.rating}/5`;
  }

  return context;
}
