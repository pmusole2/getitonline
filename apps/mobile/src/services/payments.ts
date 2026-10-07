import { apiService } from './api';

// Types
export type PaymentMethod = 'mobile_money' | 'card';
export type MobileMoneyProvider = 'mtn' | 'airtel' | 'zamtel';
export type TransactionStatus =
  | 'pending'
  | 'processing'
  | 'successful'
  | 'failed'
  | 'cancelled'
  | 'refunded';

export interface PaymentInitiationResponse {
  success: boolean;
  transactionId: string;
  reference: string;
  status: TransactionStatus;
  message?: string;
  paymentUrl?: string;
  ussdPrompt?: boolean;
}

export interface PaymentStatusResponse {
  reference: string;
  status: TransactionStatus;
  amount: number;
  currency: string;
  paymentMethod: PaymentMethod;
  fee?: number;
  netAmount?: number;
  completedAt?: string;
  failureReason?: string;
}

export interface Transaction {
  _id: string;
  orderId: string;
  userId: string;
  reference: string;
  type: 'collection' | 'transfer' | 'refund';
  paymentMethod: PaymentMethod;
  mobileMoneyProvider?: MobileMoneyProvider;
  mobileNumber?: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  fee?: number;
  netAmount?: number;
  failureReason?: string;
  initiatedAt: number;
  completedAt?: number;
  createdAt: number;
  order?: {
    orderNumber: string;
    totalAmount: number;
  };
}

class PaymentService {
  /**
   * Initiate mobile money payment
   */
  async initiateMobileMoneyPayment(params: {
    orderId: string;
    userId: string;
    amount: number;
    provider: MobileMoneyProvider;
    mobileNumber: string;
    description?: string;
  }): Promise<PaymentInitiationResponse> {
    const response = await apiService.post<PaymentInitiationResponse>(
      '/payments/mobile-money',
      params,
    );
    return response;
  }

  /**
   * Initiate card payment
   */
  async initiateCardPayment(params: {
    orderId: string;
    userId: string;
    amount: number;
    email: string;
    description?: string;
    callbackUrl?: string;
  }): Promise<PaymentInitiationResponse> {
    const response = await apiService.post<PaymentInitiationResponse>(
      '/payments/card',
      params,
    );
    return response;
  }

  async initiateCheckoutMobileMoneyPayment(params: {
    orderIds: string[];
    userId: string;
    amount: number;
    provider: MobileMoneyProvider;
    mobileNumber: string;
    description?: string;
  }): Promise<PaymentInitiationResponse> {
    return apiService.post<PaymentInitiationResponse>(
      '/payments/checkout/mobile-money',
      params,
    );
  }

  async initiateCheckoutCardPayment(params: {
    orderIds: string[];
    userId: string;
    amount: number;
    email: string;
    description?: string;
    callbackUrl?: string;
  }): Promise<PaymentInitiationResponse> {
    return apiService.post<PaymentInitiationResponse>(
      '/payments/checkout/card',
      params,
    );
  }

  /**
   * Check payment status
   */
  async checkPaymentStatus(reference: string): Promise<PaymentStatusResponse> {
    const response = await apiService.get<PaymentStatusResponse>(
      `/payments/status/${reference}`,
    );
    return response;
  }

  /**
   * Get user's payment history
   */
  async getPaymentHistory(
    userId: string,
  ): Promise<{ success: boolean; transactions: Transaction[] }> {
    const response = await apiService.get<{
      success: boolean;
      transactions: Transaction[];
    }>(`/payments/history/${userId}`);
    return response;
  }

  /**
   * Resolve mobile money account (verify before payment)
   */
  async resolveMobileMoneyAccount(
    phoneNumber: string,
    network: MobileMoneyProvider,
  ): Promise<{
    status: boolean;
    data: { phoneNumber: string; accountName: string; network: string };
  }> {
    const response = await apiService.post<{
      status: boolean;
      data: { phoneNumber: string; accountName: string; network: string };
    }>('/payments/resolve/mobile-money', { phoneNumber, network });
    return response;
  }

  /**
   * Poll for payment status until completed or timeout
   */
  async pollPaymentStatus(
    reference: string,
    options: {
      maxAttempts?: number;
      intervalMs?: number;
      onStatusChange?: (status: TransactionStatus) => void;
    } = {},
  ): Promise<PaymentStatusResponse> {
    const { maxAttempts = 60, intervalMs = 5000, onStatusChange } = options;
    let attempts = 0;
    let lastStatus: TransactionStatus | null = null;

    while (attempts < maxAttempts) {
      const status = await this.checkPaymentStatus(reference);

      if (lastStatus !== status.status) {
        lastStatus = status.status;
        onStatusChange?.(status.status);
      }

      // Terminal statuses
      if (['successful', 'failed', 'cancelled', 'refunded'].includes(status.status)) {
        return status;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      attempts++;
    }

    throw new Error('Payment status check timed out');
  }
}

export const paymentService = new PaymentService();
