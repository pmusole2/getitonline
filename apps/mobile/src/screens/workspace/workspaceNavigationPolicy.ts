export function getPrimarySellerRoute(hasListingAccess: boolean): 'CreateProduct' | 'Sell' {
  return hasListingAccess ? 'CreateProduct' : 'Sell';
}
