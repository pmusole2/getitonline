import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ConvexService } from '../convex/convex.service';
import {
  InitiateCardPaymentDto,
  InitiateMobileMoneyPaymentDto,
  LencoWebhookPayload,
  PaymentInitiationResponseDto,
  PaymentMethod,
  PaymentStatusResponseDto,
  TransactionStatus,
} from './dto/payment.dto';
import { LencoService } from './services/lenco.service';

@Controller('payments')
export class PaymentsController {
  constructor(
    private lencoService: LencoService,
    private convexService: ConvexService,
  ) {}

  /**
   * Initiate mobile money payment
   * POST /payments/mobile-money
   */
  @Post('mobile-money')
  async initiateMobileMoneyPayment(
    @Body() dto: InitiateMobileMoneyPaymentDto,
  ): Promise<PaymentInitiationResponseDto> {
    if (!this.lencoService.isConfigured()) {
      throw new HttpException(
        'Payment gateway not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      // Create transaction record in Convex
      const transaction = await this.convexService.createTransaction({
        orderId: dto.orderId,
        userId: dto.userId,
        type: 'collection',
        paymentMethod: 'mobile_money',
        amount: dto.amount,
        currency: 'ZMW',
        description: dto.description,
        mobileMoneyProvider: dto.provider,
        mobileNumber: dto.mobileNumber,
      });

      // Map provider to Lenco operator format
      const operatorMap: Record<string, 'mtn' | 'airtel' | 'zamtel'> = {
        mtn: 'mtn',
        airtel: 'airtel',
        zamtel: 'zamtel',
      };

      // Call Lenco API
      const lencoResponse = await this.lencoService.collectMobileMoney({
        amount: dto.amount,
        currency: 'ZMW',
        narration: dto.description || `Payment for order`,
        phone: dto.mobileNumber,
        operator: operatorMap[dto.provider],
        reference: transaction.reference,
        metadata: {
          orderId: dto.orderId,
          userId: dto.userId,
          transactionId: transaction.transactionId,
        },
      });

      // Update transaction with Lenco IDs
      await this.convexService.updateTransactionLencoIds({
        transactionId: transaction.transactionId,
        lencoCollectionId: lencoResponse.data.id,
        status: 'processing',
      });

      return {
        success: true,
        transactionId: transaction.transactionId,
        reference: transaction.reference,
        status: TransactionStatus.PROCESSING,
        ussdPrompt: true,
        message: 'Please approve the payment on your phone',
      };
    } catch (error) {
      console.error('Mobile money payment error:', error);

      if (error instanceof HttpException) throw error;

      throw new HttpException(
        'Failed to initiate payment',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Initiate card payment
   * POST /payments/card
   */
  @Post('card')
  async initiateCardPayment(
    @Body() dto: InitiateCardPaymentDto,
  ): Promise<PaymentInitiationResponseDto> {
    if (!this.lencoService.isConfigured()) {
      throw new HttpException(
        'Payment gateway not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      // Create transaction record in Convex
      const transaction = await this.convexService.createTransaction({
        orderId: dto.orderId,
        userId: dto.userId,
        type: 'collection',
        paymentMethod: 'card',
        amount: dto.amount,
        currency: 'ZMW',
        description: dto.description,
      });

      // Call Lenco API
      const callbackUrl =
        dto.callbackUrl ||
        `${process.env.APP_URL || 'https://gettitonline.com'}/payment/callback`;

      const lencoResponse = await this.lencoService.collectCard({
        amount: dto.amount,
        currency: 'ZMW',
        narration: dto.description || `Payment for order`,
        email: dto.email,
        reference: transaction.reference,
        callbackUrl,
        metadata: {
          orderId: dto.orderId,
          userId: dto.userId,
          transactionId: transaction.transactionId,
        },
      });

      // Update transaction with Lenco IDs
      await this.convexService.updateTransactionLencoIds({
        transactionId: transaction.transactionId,
        lencoCollectionId: lencoResponse.data.id,
        status: 'processing',
      });

      return {
        success: true,
        transactionId: transaction.transactionId,
        reference: transaction.reference,
        status: TransactionStatus.PROCESSING,
        paymentUrl: lencoResponse.data.authorizationUrl,
        message: 'Redirect user to complete card payment',
      };
    } catch (error) {
      console.error('Card payment error:', error);

      if (error instanceof HttpException) throw error;

      throw new HttpException(
        'Failed to initiate payment',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Check payment status
   * GET /payments/status/:reference
   */
  @Get('status/:reference')
  async getPaymentStatus(
    @Param('reference') reference: string,
  ): Promise<PaymentStatusResponseDto> {
    try {
      // Get transaction from Convex
      const transaction =
        await this.convexService.getTransactionByReference(reference);

      if (!transaction) {
        throw new HttpException('Transaction not found', HttpStatus.NOT_FOUND);
      }

      // If transaction is still processing, check with Lenco
      if (
        transaction.status === 'processing' ||
        transaction.status === 'pending'
      ) {
        try {
          const lencoStatus =
            await this.lencoService.getCollectionByReference(reference);

          // Map Lenco status to our status
          const statusMap: Record<string, TransactionStatus> = {
            pending: TransactionStatus.PENDING,
            processing: TransactionStatus.PROCESSING,
            successful: TransactionStatus.SUCCESSFUL,
            failed: TransactionStatus.FAILED,
            cancelled: TransactionStatus.CANCELLED,
          };

          const newStatus =
            statusMap[lencoStatus.data.status] || transaction.status;

          // Update if status changed
          if (newStatus !== transaction.status) {
            const feeValue =
              typeof lencoStatus.data.fee === 'string'
                ? parseFloat(lencoStatus.data.fee)
                : lencoStatus.data.fee;
            await this.convexService.updateTransactionStatus({
              reference,
              status: newStatus,
              fee: feeValue,
            });
          }

          return {
            reference,
            status: newStatus as TransactionStatus,
            amount: transaction.amount,
            currency: transaction.currency,
            paymentMethod: transaction.paymentMethod as PaymentMethod,
            fee: lencoStatus.data.fee,
            netAmount: transaction.amount - (lencoStatus.data.fee || 0),
          };
        } catch {
          // If Lenco check fails, return local status
        }
      }

      return {
        reference,
        status: transaction.status as TransactionStatus,
        amount: transaction.amount,
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod as PaymentMethod,
        fee: transaction.fee,
        netAmount: transaction.netAmount,
        completedAt: transaction.completedAt
          ? new Date(transaction.completedAt).toISOString()
          : undefined,
        failureReason: transaction.failureReason,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;

      throw new HttpException(
        'Failed to get payment status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Lenco webhook handler
   * POST /payments/webhook
   */
  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-lenco-signature') signature: string,
    @Body() payload: LencoWebhookPayload,
  ): Promise<{ received: boolean }> {
    console.log('📩 Received Lenco webhook:', payload.event);

    try {
      const { event, data } = payload;

      // Only handle these two events: transfer.successful and collection.successful
      const handledEvents = ['transfer.successful', 'collection.successful'];
      if (!handledEvents.includes(event)) {
        console.log(`⏭️ Skipping unhandled event: ${event}`);
        return { received: true };
      }

      // Verify signature only for events we actually handle
      const rawBody = req.rawBody?.toString() || JSON.stringify(payload);
      if (!this.lencoService.verifyWebhookSignature(rawBody, signature)) {
        console.warn('⚠️ Invalid webhook signature');
        console.log('📋 Signature details:', {
          event,
          reference: data.reference,
          receivedSignature: signature
            ? signature.substring(0, 20) + '...'
            : 'missing',
        });
        throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
      }

      // Handle collection.successful - for wallet top-ups
      if (event === 'collection.successful') {
        const statusMap: Record<string, TransactionStatus> = {
          'collection.successful': TransactionStatus.SUCCESSFUL,
          'collection.failed': TransactionStatus.FAILED,
        };

        const status = statusMap[event];
        console.log(`📋 Event: ${event} -> Status: ${status}`);

        if (status) {
          const feeValue =
            typeof data.fee === 'string' ? parseFloat(data.fee) : data.fee;

          console.log(
            `🔍 Looking up transaction - lencoId: ${data.id}, reference: ${data.reference}`,
          );

          // Retry with exponential backoff to handle timing issues
          let result: Record<string, unknown> | undefined;
          let lastError: Error | null = null;
          const maxRetries = 3;

          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              // Add delay before attempting
              const delayMs = attempt === 0 ? 500 : Math.pow(2, attempt) * 500; // 500ms, 1s, 2s
              await new Promise((resolve) => setTimeout(resolve, delayMs));

              console.log(
                `📍 Attempt ${attempt + 1}/${maxRetries} to find transaction`,
              );
              result = (await this.convexService.updateTransactionByLencoId({
                lencoCollectionId: data.id,
                reference: data.reference,
                status,
                fee: feeValue,
                failureReason: data.failureReason,
                metadata: data.metadata,
              })) as Record<string, unknown> | undefined;

              console.log(
                `✅ Transaction ${data.reference} updated to ${status}`,
              );
              console.log(
                `📋 Mutation result:`,
                JSON.stringify(result, null, 2),
              );
              break; // Success, exit retry loop
            } catch (error) {
              lastError = error as Error;
              console.error(
                `⚠️ Attempt ${attempt + 1}/${maxRetries} failed:`,
                lastError.message,
              );
              if (attempt === maxRetries - 1) {
                // Last attempt failed, log and continue (don't throw)
                console.error(
                  `❌ Final attempt failed for ${data.reference}:`,
                  lastError,
                );
              }
            }
          }

          // If this is a successful top-up (no orderId but metadata.topUp), credit the wallet
          if (
            status === TransactionStatus.SUCCESSFUL &&
            result?.userId &&
            !result?.orderId &&
            (result?.metadata as Record<string, unknown>)?.topUp
          ) {
            console.log(`💰 Crediting wallet for top-up: ${result.reference}`);
            try {
              await this.convexService.creditWallet({
                userId: result.userId as string,
                amount: result.amount as number,
                source:
                  result.paymentMethod === 'mobile_money'
                    ? 'top_up_mobile_money'
                    : 'top_up_card',
                description: `Wallet top-up successful - ${data.reference}`,
                externalReference: data.id,
              });
              console.log(`✅ Wallet credited for ${result.reference}`);
            } catch (walletError) {
              console.error(
                `❌ Failed to credit wallet for top-up ${result.reference}:`,
                walletError,
              );
              // Continue - don't fail the webhook
            }
          }
        }
      }
      // Handle transfer.successful - for wallet withdrawals
      else if (event === 'transfer.successful') {
        console.log(`📋 Withdrawal Transfer Event: ${event}`);
        console.log(
          `🔍 Looking up wallet withdrawal - lencoId: ${data.id}, reference: ${data.reference}`,
        );

        // Retry with exponential backoff
        let result: Record<string, unknown> | undefined;
        let lastError: Error | null = null;
        const maxRetries = 3;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const delayMs = attempt === 0 ? 500 : Math.pow(2, attempt) * 500;
            await new Promise((resolve) => setTimeout(resolve, delayMs));

            console.log(
              `📍 Attempt ${attempt + 1}/${maxRetries} to find wallet withdrawal`,
            );
            // Update wallet transaction by Lenco ID
            result = (await this.convexService.updateWalletTransactionByLencoId(
              {
                lencoId: data.id,
                reference: data.reference,
                status: 'completed',
                failureReason: data.failureReason,
              },
            )) as Record<string, unknown> | undefined;

            console.log(
              `✅ Wallet withdrawal ${data.reference} marked as completed`,
            );
            console.log(
              `📋 Withdrawal result:`,
              JSON.stringify(result, null, 2),
            );
            break;
          } catch (error) {
            lastError = error as Error;
            console.error(
              `⚠️ Withdrawal attempt ${attempt + 1}/${maxRetries} failed:`,
              lastError.message,
            );
            if (attempt === maxRetries - 1) {
              console.error(
                `❌ Final attempt failed for withdrawal ${data.reference}:`,
                lastError,
              );
            }
          }
        }

        // Log successful withdrawal completion
        if (result) {
          console.log(
            `✅ Withdrawal transfer successful: ${result.transaction}`,
          );
        }
      }

      return { received: true };
    } catch (error) {
      console.error('Webhook processing error:', error);
      if (error instanceof HttpException) {
        throw error;
      }

      return { received: true };
    }
  }

  /**
   * Get user's payment history
   * GET /payments/history/:userId
   */
  @Get('history/:userId')
  async getPaymentHistory(@Param('userId') userId: string) {
    try {
      const transactions = await this.convexService.getUserTransactions(userId);
      return {
        success: true,
        transactions,
      };
    } catch {
      throw new HttpException(
        'Failed to get payment history',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get available banks
   * GET /payments/banks
   */
  @Get('banks')
  async getBanks() {
    if (!this.lencoService.isConfigured()) {
      throw new HttpException(
        'Payment gateway not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      return await this.lencoService.getBanks();
    } catch {
      throw new HttpException(
        'Failed to get banks',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Resolve mobile money account
   * POST /payments/resolve/mobile-money
   */
  @Post('resolve/mobile-money')
  async resolveMobileMoney(
    @Body() body: { phoneNumber: string; network: 'mtn' | 'airtel' | 'zamtel' },
  ) {
    if (!this.lencoService.isConfigured()) {
      throw new HttpException(
        'Payment gateway not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      return await this.lencoService.resolveMobileMoney(
        body.phoneNumber,
        body.network,
      );
    } catch {
      throw new HttpException(
        'Failed to resolve account',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
