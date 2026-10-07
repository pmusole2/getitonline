import { useState, useCallback } from 'react';
import { Alert, Linking } from 'react-native';
import {
  paymentService,
  PaymentMethod,
  MobileMoneyProvider,
  TransactionStatus,
  PaymentInitiationResponse,
  PaymentStatusResponse,
} from '../services/payments';

interface UsePaymentOptions {
  onSuccess?: (response: PaymentStatusResponse) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: TransactionStatus) => void;
}

interface PaymentState {
  isLoading: boolean;
  isPending: boolean;
  error: string | null;
  transactionId: string | null;
  reference: string | null;
  status: TransactionStatus | null;
  paymentUrl: string | null;
}

export function usePayment(options: UsePaymentOptions = {}) {
  const { onSuccess, onError, onStatusChange } = options;

  const [state, setState] = useState<PaymentState>({
    isLoading: false,
    isPending: false,
    error: null,
    transactionId: null,
    reference: null,
    status: null,
    paymentUrl: null,
  });

  const resetState = useCallback(() => {
    setState({
      isLoading: false,
      isPending: false,
      error: null,
      transactionId: null,
      reference: null,
      status: null,
      paymentUrl: null,
    });
  }, []);

  /**
   * Initiate mobile money payment
   */
  const payWithMobileMoney = useCallback(
    async (params: {
      orderId: string;
      userId: string;
      amount: number;
      provider: MobileMoneyProvider;
      mobileNumber: string;
      description?: string;
    }) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const response = await paymentService.initiateMobileMoneyPayment(params);

        if (!response.success) {
          throw new Error(response.message || 'Failed to initiate payment');
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: true,
          transactionId: response.transactionId,
          reference: response.reference,
          status: response.status,
        }));

        // Show prompt to user
        Alert.alert(
          'Approve Payment',
          `Please check your ${params.provider.toUpperCase()} phone for a payment prompt of K${params.amount.toLocaleString()}.\n\nEnter your PIN to complete the payment.`,
          [{ text: 'OK' }],
        );

        // Start polling for status
        const finalStatus = await paymentService.pollPaymentStatus(
          response.reference,
          {
            maxAttempts: 60,
            intervalMs: 5000,
            onStatusChange: (status) => {
              setState((prev) => ({ ...prev, status }));
              onStatusChange?.(status);
            },
          },
        );

        setState((prev) => ({
          ...prev,
          isPending: false,
          status: finalStatus.status,
        }));

        if (finalStatus.status === 'successful') {
          onSuccess?.(finalStatus);
        } else {
          const error = new Error(
            finalStatus.failureReason || 'Payment was not successful',
          );
          onError?.(error);
        }

        return finalStatus;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Payment failed');
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: false,
          error: err.message,
        }));
        onError?.(err);
        throw err;
      }
    },
    [onSuccess, onError, onStatusChange],
  );

  /**
   * Initiate card payment
   */
  const payWithCard = useCallback(
    async (params: {
      orderId: string;
      userId: string;
      amount: number;
      email: string;
      description?: string;
    }) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const response = await paymentService.initiateCardPayment(params);

        if (!response.success) {
          throw new Error(response.message || 'Failed to initiate payment');
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: true,
          transactionId: response.transactionId,
          reference: response.reference,
          status: response.status,
          paymentUrl: response.paymentUrl || null,
        }));

        // Open card payment URL in browser
        if (response.paymentUrl) {
          const canOpen = await Linking.canOpenURL(response.paymentUrl);
          if (canOpen) {
            await Linking.openURL(response.paymentUrl);
          } else {
            throw new Error('Cannot open payment page');
          }
        }

        return response;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Payment failed');
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: false,
          error: err.message,
        }));
        onError?.(err);
        throw err;
      }
    },
    [onError],
  );

  const payCheckoutWithMobileMoney = useCallback(
    async (params: {
      orderIds: string[];
      userId: string;
      amount: number;
      provider: MobileMoneyProvider;
      mobileNumber: string;
      description?: string;
    }) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const response = await paymentService.initiateCheckoutMobileMoneyPayment(params);

        if (!response.success) {
          throw new Error(response.message || 'Failed to initiate checkout payment');
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: true,
          transactionId: response.transactionId,
          reference: response.reference,
          status: response.status,
        }));

        Alert.alert(
          'Approve Payment',
          `Please check your ${params.provider.toUpperCase()} phone for a payment prompt of K${params.amount.toLocaleString()}.\n\nEnter your PIN to complete the payment.`,
          [{ text: 'OK' }],
        );

        const finalStatus = await paymentService.pollPaymentStatus(
          response.reference,
          {
            maxAttempts: 60,
            intervalMs: 5000,
            onStatusChange: (status) => {
              setState((prev) => ({ ...prev, status }));
              onStatusChange?.(status);
            },
          },
        );

        setState((prev) => ({
          ...prev,
          isPending: false,
          status: finalStatus.status,
        }));

        if (finalStatus.status === 'successful') {
          onSuccess?.(finalStatus);
        } else {
          const error = new Error(
            finalStatus.failureReason || 'Payment was not successful',
          );
          onError?.(error);
        }

        return finalStatus;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Checkout payment failed');
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: false,
          error: err.message,
        }));
        onError?.(err);
        throw err;
      }
    },
    [onError, onStatusChange, onSuccess],
  );

  const payCheckoutWithCard = useCallback(
    async (params: {
      orderIds: string[];
      userId: string;
      amount: number;
      email: string;
      description?: string;
    }) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const response = await paymentService.initiateCheckoutCardPayment(params);

        if (!response.success) {
          throw new Error(response.message || 'Failed to initiate checkout payment');
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: true,
          transactionId: response.transactionId,
          reference: response.reference,
          status: response.status,
          paymentUrl: response.paymentUrl || null,
        }));

        if (response.paymentUrl) {
          const canOpen = await Linking.canOpenURL(response.paymentUrl);
          if (canOpen) {
            await Linking.openURL(response.paymentUrl);
          } else {
            throw new Error('Cannot open payment page');
          }
        }

        return response;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Checkout payment failed');
        setState((prev) => ({
          ...prev,
          isLoading: false,
          isPending: false,
          error: err.message,
        }));
        onError?.(err);
        throw err;
      }
    },
    [onError],
  );

  /**
   * Check payment status manually
   */
  const checkStatus = useCallback(
    async (reference?: string) => {
      const ref = reference || state.reference;
      if (!ref) {
        throw new Error('No reference to check');
      }

      setState((prev) => ({ ...prev, isLoading: true }));

      try {
        const status = await paymentService.checkPaymentStatus(ref);

        setState((prev) => ({
          ...prev,
          isLoading: false,
          status: status.status,
          isPending: !['successful', 'failed', 'cancelled', 'refunded'].includes(
            status.status,
          ),
        }));

        if (status.status === 'successful') {
          onSuccess?.(status);
        }

        return status;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Failed to check status');
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: err.message,
        }));
        throw err;
      }
    },
    [state.reference, onSuccess],
  );

  /**
   * Verify mobile money account before payment
   */
  const verifyMobileAccount = useCallback(
    async (phoneNumber: string, provider: MobileMoneyProvider) => {
      try {
        const result = await paymentService.resolveMobileMoneyAccount(
          phoneNumber,
          provider,
        );
        return result.data;
      } catch (error) {
        throw error;
      }
    },
    [],
  );

  return {
    ...state,
    payWithMobileMoney,
    payWithCard,
    payCheckoutWithMobileMoney,
    payCheckoutWithCard,
    checkStatus,
    verifyMobileAccount,
    resetState,
  };
}

/**
 * Get provider display name
 */
export function getProviderName(provider: MobileMoneyProvider): string {
  const names: Record<MobileMoneyProvider, string> = {
    mtn: 'MTN Mobile Money',
    airtel: 'Airtel Money',
    zamtel: 'Zamtel Kwacha',
  };
  return names[provider];
}

/**
 * Get provider color
 */
export function getProviderColor(provider: MobileMoneyProvider): string {
  const colors: Record<MobileMoneyProvider, string> = {
    mtn: '#FFCC00',
    airtel: '#ED1C24',
    zamtel: '#00A651',
  };
  return colors[provider];
}

/**
 * Format Zambian phone number
 */
export function formatZambianPhoneNumber(phone: string): string {
  // Remove all non-digits
  const digits = phone.replace(/\D/g, '');

  // If starts with 260, keep as is
  if (digits.startsWith('260')) {
    return digits;
  }

  // If starts with 0, replace with 260
  if (digits.startsWith('0')) {
    return '260' + digits.slice(1);
  }

  // Otherwise, assume it needs 260 prefix
  return '260' + digits;
}

/**
 * Detect mobile money provider from phone number
 */
export function detectProvider(phone: string): MobileMoneyProvider | null {
  const formatted = formatZambianPhoneNumber(phone);
  const prefix = formatted.slice(3, 5); // Get the 2 digits after 260

  // MTN prefixes: 96, 97
  if (['96', '97'].includes(prefix)) return 'mtn';

  // Airtel prefixes: 95, 77
  if (['95', '77'].includes(prefix)) return 'airtel';

  // Zamtel prefixes: 95 (some), 50, 51
  if (['50', '51'].includes(prefix)) return 'zamtel';

  return null;
}
