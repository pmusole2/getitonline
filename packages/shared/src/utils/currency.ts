/**
 * Currency utilities for ZMW (Zambian Kwacha)
 */

export const CURRENCY_CODE = "ZMW";
export const CURRENCY_SYMBOL = "K";
export const CURRENCY_LOCALE = "en-ZM";

/**
 * Format amount to ZMW currency string
 * @param amount - The amount to format
 * @param options - Formatting options
 * @returns Formatted currency string (e.g., "K 1,234.56" or "ZMW 1,234.56")
 */
export function formatZMW(
  amount: number,
  options: {
    showSymbol?: boolean;
    showCode?: boolean;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {}
): string {
  const {
    showSymbol = true,
    showCode = false,
    minimumFractionDigits = 0,
    maximumFractionDigits = 2,
  } = options;

  const formatter = new Intl.NumberFormat(CURRENCY_LOCALE, {
    style: "decimal",
    minimumFractionDigits,
    maximumFractionDigits,
  });

  const formattedAmount = formatter.format(amount);

  if (showCode) {
    return `${CURRENCY_CODE} ${formattedAmount}`;
  }

  if (showSymbol) {
    return `${CURRENCY_SYMBOL} ${formattedAmount}`;
  }

  return formattedAmount;
}

/**
 * Format amount to compact ZMW (e.g., K 1.2M, K 500K)
 * @param amount - The amount to format
 * @returns Compact formatted string
 */
export function formatZMWCompact(amount: number): string {
  if (amount >= 1000000) {
    return `${CURRENCY_SYMBOL} ${(amount / 1000000).toFixed(1)}M`;
  }
  if (amount >= 1000) {
    return `${CURRENCY_SYMBOL} ${(amount / 1000).toFixed(1)}K`;
  }
  return formatZMW(amount);
}

/**
 * Parse ZMW string to number
 * @param value - The string value to parse
 * @returns Parsed number or NaN
 */
export function parseZMW(value: string): number {
  // Remove currency symbol, code, and thousand separators
  const cleaned = value
    .replace(/[KZMWzmw\s]/g, "")
    .replace(/,/g, "");
  return parseFloat(cleaned);
}

/**
 * Validate if amount is valid ZMW
 * @param amount - The amount to validate
 * @returns Whether the amount is valid
 */
export function isValidZMWAmount(amount: number): boolean {
  return (
    typeof amount === "number" &&
    !isNaN(amount) &&
    isFinite(amount) &&
    amount >= 0 &&
    amount <= 100000000 // Max 100 million ZMW
  );
}

/**
 * Round to valid ZMW amount (2 decimal places)
 * @param amount - The amount to round
 * @returns Rounded amount
 */
export function roundZMW(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Calculate percentage
 * @param amount - The base amount
 * @param percentage - The percentage to calculate
 * @returns Calculated percentage amount
 */
export function calculatePercentage(amount: number, percentage: number): number {
  return roundZMW((amount * percentage) / 100);
}

/**
 * Calculate discount
 * @param originalPrice - The original price
 * @param discountedPrice - The discounted price
 * @returns Discount percentage
 */
export function calculateDiscountPercentage(
  originalPrice: number,
  discountedPrice: number
): number {
  if (originalPrice <= 0) return 0;
  const discount = ((originalPrice - discountedPrice) / originalPrice) * 100;
  return Math.round(discount);
}
