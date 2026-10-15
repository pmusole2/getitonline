/**
 * Wallet types and read/display helpers
 */

// Types
export type MobileMoneyProvider = 'mtn' | 'airtel' | 'zamtel';

export interface WalletBalance {
  balance: number;
  pendingBalance: number;
  totalEarned: number;
  totalWithdrawn: number;
  totalSpent: number;
  hasWallet: boolean;
  isActive?: boolean;
  isFrozen?: boolean;
}

export interface WalletTransaction {
  _id: string;
  type: 'credit' | 'debit' | 'hold' | 'release' | 'refund';
  source: string;
  amount: number;
  balanceAfter: number;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  description: string;
  reference: string;
  createdAt: number;
  completedAt?: number;
  orderId?: string;
}

export interface WalletActivity {
  recentTransactions: WalletTransaction[];
  pendingWithdrawals: number;
  thisMonthEarnings: number;
  thisMonthWithdrawals: number;
}

export interface WithdrawalResponse {
  success: boolean;
  reference: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  message?: string;
  transactionId?: string;
  newBalance?: number;
}

export interface TopUpResponse {
  success: boolean;
  reference: string;
  message: string;
  checkoutUrl?: string;
}

export interface WalletPaymentResponse {
  success: boolean;
  reference: string;
  message: string;
  newBalance: number;
}

// Helper functions
export function formatWalletAmount(amount: number): string {
  return `K${amount.toLocaleString('en-ZM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function getTransactionTypeLabel(type: WalletTransaction['type']): string {
  const labels: Record<WalletTransaction['type'], string> = {
    credit: 'Received',
    debit: 'Sent',
    hold: 'Held',
    release: 'Released',
    refund: 'Refunded',
  };
  return labels[type] || type;
}

export function getTransactionSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    sale: 'Sale Earnings',
    top_up_mobile_money: 'Mobile Money Top-up',
    top_up_card: 'Card Top-up',
    top_up_bank: 'Bank Transfer Top-up',
    refund: 'Order Refund',
    withdrawal_reversal: 'Withdrawal Reversed',
    admin_adjustment: 'Admin Adjustment',
    purchase: 'Purchase',
    withdrawal_mobile_money: 'Mobile Money Withdrawal',
    withdrawal_bank: 'Bank Withdrawal',
    escrow_hold: 'Escrow Hold',
    escrow_release: 'Sale Complete',
  };
  return labels[source] || source.replace(/_/g, ' ');
}

export function getTransactionIcon(type: WalletTransaction['type'], source: string): string {
  if (source.includes('withdrawal')) return 'bank-transfer-out';
  if (source.includes('top_up')) return 'bank-transfer-in';
  if (source === 'sale' || source === 'escrow_release') return 'cash-plus';
  if (source === 'purchase') return 'shopping';
  if (source === 'refund') return 'cash-refund';

  const icons: Record<WalletTransaction['type'], string> = {
    credit: 'arrow-down-circle',
    debit: 'arrow-up-circle',
    hold: 'lock',
    release: 'lock-open',
    refund: 'cash-refund',
  };
  return icons[type] || 'cash';
}

export function getTransactionColor(type: WalletTransaction['type'], status: WalletTransaction['status']): string {
  if (status === 'failed' || status === 'cancelled') return '#EF4444';
  if (status === 'pending') return '#F59E0B';

  const colors: Record<WalletTransaction['type'], string> = {
    credit: '#10B981',
    debit: '#EF4444',
    hold: '#F59E0B',
    release: '#10B981',
    refund: '#10B981',
  };
  return colors[type] || '#6B7280';
}
