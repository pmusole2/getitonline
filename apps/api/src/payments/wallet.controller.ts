import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { LencoService, LencoTransferResponse } from './services/lenco.service';
import { ConvexService } from '../convex/convex.service';
import {
  WithdrawToMobileMoneyDto,
  WithdrawToBankDto,
  TopUpWalletDto,
  PayWithWalletDto,
  WithdrawalResponseDto,
  WalletBalanceDto,
  WalletActivityDto,
} from './dto/wallet.dto';

@ApiTags('Wallet')
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly lencoService: LencoService,
    private readonly convexService: ConvexService,
  ) {}

  /**
   * Get wallet balance
   */
  @Get('balance/:userId')
  @ApiOperation({ summary: 'Get user wallet balance' })
  @ApiResponse({ status: 200, type: WalletBalanceDto })
  async getBalance(@Param('userId') userId: string): Promise<WalletBalanceDto> {
    try {
      const balance = await this.convexService.getWalletBalance(userId);
      return balance;
    } catch (error) {
      console.error('Failed to get wallet balance:', error);
      throw new HttpException(
        'Failed to get wallet balance',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get wallet activity and transactions
   */
  @Get('activity/:userId')
  @ApiOperation({ summary: 'Get user wallet activity' })
  @ApiResponse({ status: 200, type: WalletActivityDto })
  async getActivity(@Param('userId') userId: string) {
    try {
      const activity = await this.convexService.getWalletActivity(userId);
      return activity;
    } catch (error) {
      console.error('Failed to get wallet activity:', error);
      throw new HttpException(
        'Failed to get wallet activity',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get wallet transactions
   */
  @Get('transactions/:userId')
  @ApiOperation({ summary: 'Get user wallet transactions' })
  async getTransactions(
    @Param('userId') userId: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const transactions =
        await this.convexService.getWalletTransactions(userId);
      return transactions;
    } catch (error) {
      console.error('Failed to get wallet transactions:', error);
      throw new HttpException(
        'Failed to get wallet transactions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Withdraw to mobile money
   */
  @Post('withdraw/mobile-money')
  @ApiOperation({ summary: 'Withdraw funds to mobile money' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  async withdrawToMobileMoney(
    @Body() dto: WithdrawToMobileMoneyDto,
  ): Promise<WithdrawalResponseDto> {
    try {
      // Check if Lenco is configured
      if (!this.lencoService.isConfigured()) {
        throw new HttpException(
          'Payment gateway not configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // Check wallet balance
      const balance = await this.convexService.getWalletBalance(dto.userId);
      if (!balance.hasWallet) {
        throw new HttpException('Wallet not found', HttpStatus.NOT_FOUND);
      }
      if (balance.isFrozen) {
        throw new HttpException('Wallet is frozen', HttpStatus.FORBIDDEN);
      }
      if (balance.balance < dto.amount) {
        throw new HttpException('Insufficient balance', HttpStatus.BAD_REQUEST);
      }

      // Generate reference
      const timestamp = Date.now().toString(36).toUpperCase();
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      const reference = `WDR-MM-${timestamp}-${random}`;

      // Debit wallet first (pessimistic - debit before transfer)
      const debitResult = await this.convexService.debitWallet({
        userId: dto.userId,
        amount: dto.amount,
        source: 'withdrawal_mobile_money',
        description:
          dto.description ||
          `Withdrawal to ${dto.provider.toUpperCase()} ${dto.phone}`,
        externalReference: reference,
      });

      try {
        console.log('[Withdrawal] Initiating Lenco mobile money transfer');

        // Initiate Lenco transfer
        const lencoResponse: LencoTransferResponse =
          await this.lencoService.transferToMobileMoney({
            phone: dto.phone,
            operator: dto.provider,
            amount: dto.amount,
            reference,
            narration: `Wallet withdrawal - ${reference}`,
          });

        console.log('[Withdrawal] Lenco response received');

        // Update transaction with Lenco ID
        await this.convexService.updateWalletTransactionExternal(
          debitResult.reference,
          lencoResponse.data.id,
        );

        console.log('[Withdrawal] Transaction updated with provider response');

        return {
          success: true,
          reference: debitResult.reference,
          status:
            lencoResponse.data.status === 'successful'
              ? 'completed'
              : 'pending',
          message: 'Withdrawal initiated successfully',
          transactionId: lencoResponse.data.id,
          newBalance: debitResult.newBalance,
        };
      } catch (lencoError) {
        // Lenco transfer failed - reverse the wallet debit
        console.error('[Withdrawal] Lenco transfer failed');

        try {
          await this.convexService.updateWalletWithdrawalStatus(
            debitResult.reference,
            'failed',
            lencoError instanceof Error
              ? lencoError.message
              : 'Transfer failed',
          );
          console.log(
            `✅ [Withdrawal] Transaction marked as failed and funds reversed`,
          );
        } catch {
          console.error(
            '[Withdrawal] Failed to update transaction status after transfer failure',
          );
        }

        throw new HttpException(
          'Transfer failed. Funds have been returned to your wallet.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Withdrawal to mobile money failed');
      throw new HttpException(
        'Withdrawal failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Withdraw to bank account
   */
  @Post('withdraw/bank')
  @ApiOperation({ summary: 'Withdraw funds to bank account' })
  @ApiResponse({ status: 200, type: WithdrawalResponseDto })
  async withdrawToBank(
    @Body() dto: WithdrawToBankDto,
  ): Promise<WithdrawalResponseDto> {
    try {
      // Check if Lenco is configured
      if (!this.lencoService.isConfigured()) {
        throw new HttpException(
          'Payment gateway not configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // Check wallet balance
      const balance = await this.convexService.getWalletBalance(dto.userId);
      if (!balance.hasWallet) {
        throw new HttpException('Wallet not found', HttpStatus.NOT_FOUND);
      }
      if (balance.isFrozen) {
        throw new HttpException('Wallet is frozen', HttpStatus.FORBIDDEN);
      }
      if (balance.balance < dto.amount) {
        throw new HttpException('Insufficient balance', HttpStatus.BAD_REQUEST);
      }

      // Generate reference
      const timestamp = Date.now().toString(36).toUpperCase();
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      const reference = `WDR-BK-${timestamp}-${random}`;

      // Debit wallet first
      const debitResult = await this.convexService.debitWallet({
        userId: dto.userId,
        amount: dto.amount,
        source: 'withdrawal_bank',
        description:
          dto.description ||
          `Withdrawal to bank account ${dto.accountNumber.slice(-4)}`,
        externalReference: reference,
      });

      try {
        console.log('[Withdrawal] Initiating Lenco bank transfer');

        // Initiate Lenco transfer
        const lencoResponse: LencoTransferResponse =
          await this.lencoService.transferToBank({
            bankCode: dto.bankCode,
            accountNumber: dto.accountNumber,
            accountName: dto.accountName,
            amount: dto.amount,
            reference,
            narration: `Wallet withdrawal - ${reference}`,
          });

        console.log('[Withdrawal] Lenco response received');

        // Update transaction with Lenco ID
        await this.convexService.updateWalletTransactionExternal(
          debitResult.reference,
          lencoResponse.data.id,
        );

        console.log('[Withdrawal] Transaction updated with provider response');

        return {
          success: true,
          reference: debitResult.reference,
          status:
            lencoResponse.data.status === 'successful'
              ? 'completed'
              : 'pending',
          message: 'Withdrawal initiated successfully',
          transactionId: lencoResponse.data.id,
          newBalance: debitResult.newBalance,
        };
      } catch (lencoError) {
        // Lenco transfer failed - reverse the wallet debit
        console.error('[Withdrawal] Lenco bank transfer failed');

        try {
          await this.convexService.updateWalletWithdrawalStatus(
            debitResult.reference,
            'failed',
            lencoError instanceof Error
              ? lencoError.message
              : 'Transfer failed',
          );
          console.log(
            `✅ [Withdrawal] Transaction marked as failed and funds reversed`,
          );
        } catch {
          console.error(
            '[Withdrawal] Failed to update transaction status after transfer failure',
          );
        }

        throw new HttpException(
          'Transfer failed. Funds have been returned to your wallet.',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Withdrawal to bank failed');
      throw new HttpException(
        'Withdrawal failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Top up wallet via mobile money
   */
  @Post('top-up')
  @ApiOperation({ summary: 'Top up wallet balance' })
  async topUpWallet(@Body() dto: TopUpWalletDto): Promise<{
    success: boolean;
    reference: string;
    message: string;
    checkoutUrl?: string;
  }> {
    try {
      if (!this.lencoService.isConfigured()) {
        throw new HttpException(
          'Payment gateway not configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      // Generate reference
      const timestamp = Date.now().toString(36).toUpperCase();
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      const reference = `TOP-${timestamp}-${random}`;

      if (dto.paymentMethod === 'mobile_money') {
        if (!dto.mobileNumber || !dto.provider) {
          throw new HttpException(
            'Mobile number and provider are required',
            HttpStatus.BAD_REQUEST,
          );
        }

        // Initiate mobile money collection for top-up
        const lencoResponse = await this.lencoService.collectMobileMoney({
          phone: dto.mobileNumber,
          operator: dto.provider,
          amount: dto.amount,
          currency: 'ZMW',
          reference,
          narration: 'Wallet top-up',
        });

        // Store pending top-up transaction (will be credited on webhook)
        await this.convexService.createPendingTopUp({
          userId: dto.userId,
          amount: dto.amount,
          reference,
          lencoCollectionId: lencoResponse.data.id,
          paymentMethod: 'mobile_money',
          provider: dto.provider,
        });

        return {
          success: true,
          reference,
          message: 'Please confirm the payment on your phone',
        };
      } else {
        // Card top-up - redirect to checkout
        if (!dto.email) {
          throw new HttpException(
            'Email is required for card payments',
            HttpStatus.BAD_REQUEST,
          );
        }

        const lencoResponse = await this.lencoService.collectCard({
          amount: dto.amount,
          currency: 'ZMW',
          reference,
          narration: 'Wallet top-up',
          email: dto.email,
          callbackUrl: `${
            process.env.APP_URL || 'https://gettitonline.com'
          }/wallet/top-up/callback`,
        });

        // Store pending top-up transaction
        await this.convexService.createPendingTopUp({
          userId: dto.userId,
          amount: dto.amount,
          reference,
          lencoCollectionId: lencoResponse.data.id,
          paymentMethod: 'card',
        });

        return {
          success: true,
          reference,
          message: 'Redirecting to payment page',
          checkoutUrl: lencoResponse.data.authorizationUrl,
        };
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Top-up failed');
      throw new HttpException(
        'Top-up failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Pay for order using wallet
   */
  @Post('pay')
  @ApiOperation({ summary: 'Pay for order using wallet balance' })
  async payWithWallet(@Body() dto: PayWithWalletDto): Promise<{
    success: boolean;
    reference: string;
    message: string;
    newBalance: number;
  }> {
    try {
      // Check wallet balance
      const balance = await this.convexService.getWalletBalance(dto.userId);
      if (!balance.hasWallet) {
        throw new HttpException('Wallet not found', HttpStatus.NOT_FOUND);
      }
      if (balance.isFrozen) {
        throw new HttpException('Wallet is frozen', HttpStatus.FORBIDDEN);
      }
      if (balance.balance < dto.amount) {
        throw new HttpException(
          `Insufficient balance. Available: K${balance.balance.toLocaleString()}`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // Get order details for description
      const order = await this.convexService.getOrder(dto.orderId);
      if (!order) {
        throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
      }

      // Debit wallet for purchase
      const result = await this.convexService.debitWallet({
        userId: dto.userId,
        amount: dto.amount,
        source: 'purchase',
        description: `Payment for order #${order.orderNumber}`,
        orderId: dto.orderId,
      });

      // Mark order as paid (using wallet)
      await this.convexService.markOrderPaidByWallet(
        dto.orderId,
        result.reference,
      );

      return {
        success: true,
        reference: result.reference,
        message: 'Payment successful',
        newBalance: result.newBalance,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Wallet payment failed');
      throw new HttpException(
        'Payment failed',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Ensure wallet exists for user
   */
  @Post('ensure/:userId')
  @ApiOperation({ summary: 'Ensure wallet exists for user' })
  async ensureWallet(
    @Param('userId') userId: string,
  ): Promise<{ walletId: string }> {
    try {
      const wallet = await this.convexService.ensureWallet(userId);
      return { walletId: wallet._id };
    } catch (error) {
      console.error('Failed to ensure wallet:', error);
      throw new HttpException(
        'Failed to create wallet',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Get platform Lenco account balance (admin only)
   */
  @Get('platform/balance')
  @ApiOperation({ summary: 'Get platform Lenco account balance (admin)' })
  async getPlatformBalance(): Promise<{
    balance: number;
    availableBalance: number;
    currency: string;
  }> {
    try {
      if (!this.lencoService.isConfigured()) {
        throw new HttpException(
          'Payment gateway not configured',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      const result = await this.lencoService.getAccountBalance();
      return {
        balance: result.data.balance,
        availableBalance: result.data.availableBalance,
        currency: result.data.currency,
      };
    } catch (error) {
      console.error('Failed to get platform balance:', error);
      throw new HttpException(
        'Failed to get balance',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
