import { useMemo } from 'react';

// Platform fee percentage (5% to cover transaction fees)
export const PLATFORM_FEE_PERCENTAGE = 0.05;

export interface OrderTotalBreakdown {
  subtotal: number; // Already includes platform fee in displayed prices
  shippingCost: number;
  platformFee: number; // Calculated for backend tracking
  platformFeePercentage: number;
  totalAmount: number;
  sellerPayout: number;
  breakdown: {
    youPay: number;
    sellerReceives: number;
    platformRetains: number;
  };
}

/**
 * Calculate the display price (seller's price + 5% fee)
 * This is what buyers see on product cards
 */
export function calculateDisplayPrice(sellerPrice: number): number {
  return Math.ceil(sellerPrice * (1 + PLATFORM_FEE_PERCENTAGE) * 100) / 100;
}

/**
 * Calculate the seller's base price from display price
 */
export function calculateSellerPrice(displayPrice: number): number {
  return Math.floor(displayPrice / (1 + PLATFORM_FEE_PERCENTAGE) * 100) / 100;
}

/**
 * Calculate platform fee from seller's price
 */
export function calculatePlatformFee(sellerPrice: number): number {
  return Math.ceil(sellerPrice * PLATFORM_FEE_PERCENTAGE * 100) / 100;
}

/**
 * Calculate order total
 * Note: subtotal already includes the 5% markup in displayed prices
 * We track platformFee separately for backend accounting
 */
export function calculateOrderTotal(
  displaySubtotal: number, // Already marked up prices
  shippingCost: number
): OrderTotalBreakdown {
  // Calculate what portion is platform fee (from the already marked-up prices)
  const sellerPayout = Math.floor(displaySubtotal / (1 + PLATFORM_FEE_PERCENTAGE) * 100) / 100;
  const platformFee = displaySubtotal - sellerPayout;

  // Total buyer pays: subtotal (already includes fee) + shipping
  const totalAmount = displaySubtotal + shippingCost;

  // Seller receives their base amount + shipping
  const sellerPayoutWithShipping = sellerPayout + shippingCost;

  return {
    subtotal: displaySubtotal,
    shippingCost,
    platformFee,
    platformFeePercentage: PLATFORM_FEE_PERCENTAGE * 100,
    totalAmount,
    sellerPayout: sellerPayoutWithShipping,
    breakdown: {
      youPay: totalAmount,
      sellerReceives: sellerPayoutWithShipping,
      platformRetains: platformFee,
    },
  };
}

/**
 * Hook to calculate order total
 */
export function useOrderTotal(
  displaySubtotal: number,
  shippingCost: number
): OrderTotalBreakdown {
  return useMemo(
    () => calculateOrderTotal(displaySubtotal, shippingCost),
    [displaySubtotal, shippingCost]
  );
}

/**
 * Format currency in ZMW
 */
export function formatZMW(amount: number): string {
  return `K${amount.toLocaleString('en-ZM', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Get fee explanation for sellers
 */
export function getSellerFeeNote(): string {
  return `A ${PLATFORM_FEE_PERCENTAGE * 100}% service fee will be added to your price for buyers. This covers secure payment processing and escrow protection.`;
}

/**
 * Get fee explanation text
 */
export function getPlatformFeeExplanation(): string {
  return `Prices include a ${PLATFORM_FEE_PERCENTAGE * 100}% service fee for secure payment processing, escrow protection, and platform services.`;
}
