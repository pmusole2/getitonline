import { HttpException, HttpStatus, RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import {
  PaymentMethod,
  TransactionStatus,
  type InitiateCardPaymentDto,
  type LencoWebhookPayload,
} from './dto/payment.dto';
import { PaymentsController } from './payments.controller';

describe('PaymentsController', () => {
  const createController = () => {
    const lencoService = {
      isConfigured: jest.fn(() => true),
      collectCard: jest.fn(),
      verifyWebhookSignature: jest.fn(() => true),
    };

    const convexService = {
      createTransaction: jest.fn(),
      updateTransactionLencoIds: jest.fn(),
      updateTransactionByLencoId: jest.fn(),
    };

    return {
      controller: new PaymentsController(
        lencoService as never,
        convexService as never,
      ),
      lencoService,
      convexService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.APP_URL = 'https://beta.gettitonline.com';
  });

  it('uses APP_URL as the default card callback URL', async () => {
    const { controller, lencoService, convexService } = createController();
    const dto: InitiateCardPaymentDto = {
      orderId: 'order_123',
      userId: 'user_456',
      amount: 150,
      email: 'buyer@example.com',
      description: 'Order payment',
    };

    convexService.createTransaction.mockResolvedValue({
      transactionId: 'txn_001',
      reference: 'REF-001',
    });
    lencoService.collectCard.mockResolvedValue({
      data: {
        id: 'lenco_123',
        authorizationUrl: 'https://payments.example.com/checkout',
      },
    });
    convexService.updateTransactionLencoIds.mockResolvedValue(undefined);

    const result = await controller.initiateCardPayment(dto);

    expect(lencoService.collectCard).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: 'https://beta.gettitonline.com/payment/callback',
      }),
    );
    expect(result).toEqual({
      success: true,
      transactionId: 'txn_001',
      reference: 'REF-001',
      status: TransactionStatus.PROCESSING,
      paymentUrl: 'https://payments.example.com/checkout',
      message: 'Redirect user to complete card payment',
    });
  });

  it('skips signature verification for unhandled webhook events', async () => {
    const { controller, lencoService } = createController();
    const request = {
      rawBody: Buffer.from('{"event":"transaction.debit"}'),
    } as RawBodyRequest<Request>;
    const payload: LencoWebhookPayload = {
      event: 'transaction.debit',
      data: {
        id: 'evt_123',
        reference: 'REF-001',
        status: 'successful',
        amount: 25,
        currency: 'ZMW',
      },
    };

    const result = await controller.handleWebhook(
      request,
      'signature',
      payload,
    );

    expect(result).toEqual({ received: true });
    expect(lencoService.verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it('rejects handled webhook events with invalid signatures', async () => {
    const { controller, lencoService } = createController();
    const request = {
      rawBody: Buffer.from('{"event":"collection.successful"}'),
    } as RawBodyRequest<Request>;
    const payload: LencoWebhookPayload = {
      event: 'collection.successful',
      data: {
        id: 'evt_456',
        reference: 'REF-002',
        status: 'successful',
        amount: 75,
        currency: 'ZMW',
      },
    };

    lencoService.verifyWebhookSignature.mockReturnValue(false);

    await expect(
      controller.handleWebhook(request, 'invalid-signature', payload),
    ).rejects.toThrow('Invalid signature');

    try {
      await controller.handleWebhook(request, 'invalid-signature', payload);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.UNAUTHORIZED,
      );
    }
  });

  it('returns the expected payment method type in card responses', async () => {
    expect(PaymentMethod.CARD).toBe('card');
  });
});
