import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsNotEmpty,
  Min,
} from 'class-validator';

// Payment method types
export enum PaymentMethod {
  MOBILE_MONEY = 'mobile_money',
  CARD = 'card',
  BANK_TRANSFER = 'bank_transfer',
}

// Mobile money providers in Zambia
export enum MobileMoneyProvider {
  MTN = 'mtn',
  AIRTEL = 'airtel',
  ZAMTEL = 'zamtel',
}

// Transaction status
export enum TransactionStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCESSFUL = 'successful',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

// DTO for initiating mobile money payment
export class InitiateMobileMoneyPaymentDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsEnum(MobileMoneyProvider)
  provider: MobileMoneyProvider;

  @IsString()
  @IsNotEmpty()
  mobileNumber: string;

  @IsString()
  @IsOptional()
  description?: string;
}

// DTO for initiating card payment
export class InitiateCardPaymentDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsString()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  callbackUrl?: string;
}

// Response for payment initiation
export class PaymentInitiationResponseDto {
  success: boolean;
  transactionId: string;
  reference: string;
  status: TransactionStatus;
  message?: string;
  // For card payments - redirect URL
  paymentUrl?: string;
  // For mobile money - USSD prompt expected
  ussdPrompt?: boolean;
}

// DTO for checking payment status
export class CheckPaymentStatusDto {
  @IsString()
  @IsNotEmpty()
  reference: string;
}

// Response for payment status
export class PaymentStatusResponseDto {
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

// Lenco webhook payload types
export interface LencoWebhookPayload {
  event: string;
  data: {
    id: string;
    reference: string;
    status: string;
    amount: number;
    fee?: number;
    currency: string;
    narration?: string;
    metadata?: Record<string, unknown>;
    paidAt?: string;
    failedAt?: string;
    failureReason?: string;
  };
}

// Lenco collection request (Mobile Money)
export interface LencoMobileMoneyCollectionRequest {
  accountId: string;
  amount: number;
  currency: string;
  narration: string;
  phone: string; // Lenco API expects 'phone' field
  operator: 'mtn' | 'airtel' | 'zamtel'; // Lenco API expects 'operator' field
  reference: string;
  metadata?: Record<string, unknown>;
}

// Lenco collection request (Card)
export interface LencoCardCollectionRequest {
  accountId: string;
  amount: number;
  currency: string;
  narration: string;
  email: string;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

// Lenco collection response
export interface LencoCollectionResponse {
  status: boolean;
  message: string;
  data: {
    id: string;
    reference: string;
    status: string;
    amount: number;
    fee: number;
    currency: string;
    narration: string;
    authorizationUrl?: string; // For card payments
    createdAt: string;
  };
}

// Lenco API error
export interface LencoApiError {
  status: boolean;
  message: string;
  errors?: Record<string, string[]>;
}
