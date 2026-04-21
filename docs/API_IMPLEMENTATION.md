# Gettitonline API - Implementation Documentation

This is the detailed API reference. For the canonical startup path, deployment steps, and release checks, start with the root [README.md](/Users/macbookair/Desktop/Auto%20Marketplace/README.md).

## Overview

**Framework:** NestJS v10.0.0 with TypeScript
**Port:** 3001
**API Prefix:** `/api/v1`
**Documentation:** Swagger available at `/docs`

The API is the backend service layer for the Gettitonline, handling payment processing, AI-powered features, and integration with the Convex database.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Getting Started](#getting-started)
3. [Environment Variables](#environment-variables)
4. [Modules](#modules)
5. [API Endpoints](#api-endpoints)
6. [External Integrations](#external-integrations)
7. [Payment Flows](#payment-flows)
8. [Error Handling](#error-handling)

---

## Architecture

### Folder Structure

```
apps/api/
├── src/
│   ├── main.ts                 # Application entry point
│   ├── app.module.ts           # Root module
│   ├── config/                 # Configuration module
│   │   ├── config.module.ts
│   │   └── configuration.ts
│   ├── convex/                 # Convex backend integration
│   │   ├── convex.module.ts
│   │   └── convex.service.ts   # 652 lines - HTTP client for Convex
│   ├── health/                 # Health check endpoints
│   │   ├── health.module.ts
│   │   └── health.controller.ts
│   ├── payments/               # Payment processing
│   │   ├── payments.module.ts
│   │   ├── payments.controller.ts   # 544 lines
│   │   ├── wallet.controller.ts     # 535 lines
│   │   ├── services/
│   │   │   └── lenco.service.ts     # 356 lines - Payment gateway
│   │   └── dto/
│   │       ├── payment.dto.ts
│   │       └── wallet.dto.ts
│   └── ai/                     # AI/ML features
│       ├── ai.module.ts
│       ├── ai.controller.ts         # 327 lines
│       ├── ai.service.ts            # OpenAI integration
│       ├── services/
│       │   ├── recommendations.service.ts
│       │   ├── message-rephrase.service.ts
│       │   ├── dispute-analysis.service.ts
│       │   └── chat.service.ts
│       └── dto/
├── .env                        # Environment variables
└── package.json
```

### Module Dependencies

```
AppModule
├── ConfigModule (global)
├── ConvexModule (global)
├── HealthModule
├── PaymentsModule
│   └── ConvexModule, ConfigModule
└── AIModule
    └── ConvexModule, ConfigModule
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Convex account with deployed backend
- Lenco payment gateway account
- OpenAI API key

### Installation

```bash
cd apps/api
npm install
```

### Running the API

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

### Swagger Documentation

Access the API documentation at: `http://localhost:3001/docs`

---

## Environment Variables

Create a `.env` file in the `apps/api` directory:

```env
# Server
PORT=3001

# Convex Backend
CONVEX_URL=https://your-project.convex.cloud

# CORS (comma-separated origins)
CORS_ORIGINS=http://localhost:8081,http://localhost:19006,http://localhost:3000

# OpenAI (for AI features)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini

# Lenco Payment Gateway
LENCO_ACCOUNT_ID=your-account-id
LENCO_API_KEY=your-api-key
LENCO_SECRET_KEY=your-secret-key
LENCO_BASE_URL=https://api.lenco.co/access/v2

# Application
APP_URL=https://your-app-url.com
```

---

## Modules

### 1. Config Module

**Location:** `src/config/`

Loads and provides environment variables globally using NestJS ConfigModule.

```typescript
// Access configuration in any service
constructor(private configService: ConfigService) {}

const apiKey = this.configService.get<string>('OPENAI_API_KEY');
```

### 2. Convex Module

**Location:** `src/convex/`

Provides HTTP-based client for Convex backend. This is the bridge between the NestJS API and the Convex database.

**Key Methods in ConvexService:**

| Category | Methods |
|----------|---------|
| **Users** | `getUser()`, `getUserByClerkId()`, `upsertUser()` |
| **Products** | `getProduct()`, `getActiveProducts()`, `searchProducts()`, `getProductsByCategories()` |
| **Orders** | `getOrder()`, `getComprehensiveOrderDetails()`, `getOrderTransactions()`, `getUserOrders()`, `getSellerOrders()` |
| **Disputes** | `getDispute()`, `getDisputeForAnalysis()`, `updateDisputeAiAnalysis()` |
| **Transactions** | `createTransaction()`, `updateTransactionStatus()`, `getTransactionByReference()` |
| **Wallet** | `getWalletBalance()`, `creditWallet()`, `debitWallet()`, `canPayWithWallet()`, `ensureWallet()` |
| **Messages** | `getProductConversationHistory()`, `getMessages()` |
| **Stats** | `getMarketplaceStats()`, `getCategories()` |

### 3. Health Module

**Location:** `src/health/`

Provides health check endpoints for monitoring.

### 4. Payments Module

**Location:** `src/payments/`

Handles all payment operations including mobile money, card payments, and wallet management.

**Services:**
- `LencoService` - Integration with Lenco payment gateway

### 5. AI Module

**Location:** `src/ai/`

AI-powered features using OpenAI.

**Services:**
- `AIService` - Core OpenAI integration
- `RecommendationsService` - Product recommendations
- `MessageRephraseService` - Message analysis and rephrasing
- `DisputeAnalysisService` - AI dispute resolution
- `ChatService` - General chat assistant

---

## API Endpoints

### Health Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/health` | General health check |
| GET | `/api/v1/health/ready` | Readiness check |
| GET | `/api/v1/health/live` | Liveness check |

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "gettitonline-api",
  "version": "1.0.0"
}
```

---

### Payment Endpoints

#### Initiate Mobile Money Payment

```http
POST /api/v1/payments/mobile-money
```

**Request Body:**
```json
{
  "orderId": "order_123",
  "userId": "user_456",
  "amount": 1500,
  "provider": "MTN",
  "mobileNumber": "260971234567",
  "description": "Order #12345"
}
```

**Response:**
```json
{
  "success": true,
  "transactionId": "txn_789",
  "reference": "REF123456",
  "status": "pending",
  "message": "Please approve the payment on your phone"
}
```

#### Initiate Card Payment

```http
POST /api/v1/payments/card
```

**Request Body:**
```json
{
  "orderId": "order_123",
  "userId": "user_456",
  "amount": 1500,
  "email": "user@example.com",
  "description": "Order #12345",
  "callbackUrl": "https://app.com/payment/callback"
}
```

**Response:**
```json
{
  "success": true,
  "transactionId": "txn_789",
  "reference": "REF123456",
  "status": "pending",
  "paymentUrl": "https://pay.lenco.co/checkout/..."
}
```

#### Check Payment Status

```http
GET /api/v1/payments/status/:reference
```

**Response:**
```json
{
  "reference": "REF123456",
  "status": "successful",
  "amount": 1500,
  "currency": "ZMW",
  "paymentMethod": "mobile_money",
  "fee": 45,
  "netAmount": 1455,
  "completedAt": "2024-01-15T10:35:00.000Z"
}
```

#### Webhook Handler

```http
POST /api/v1/payments/webhook
```

Handles Lenco webhook events:
- `collection.successful` - Payment received
- `transfer.successful` - Withdrawal completed

**Important:** Always returns `{ received: true }` to prevent Lenco retries.

#### Get Payment History

```http
GET /api/v1/payments/history/:userId
```

#### Get Available Banks

```http
GET /api/v1/payments/banks
```

#### Resolve Mobile Money Account

```http
POST /api/v1/payments/resolve/mobile-money
```

---

### Wallet Endpoints

#### Get Wallet Balance

```http
GET /api/v1/wallet/balance/:userId
```

**Response:**
```json
{
  "balance": 5000,
  "pendingBalance": 1500,
  "totalEarned": 25000,
  "totalWithdrawn": 18000,
  "totalSpent": 2000,
  "hasWallet": true,
  "isActive": true,
  "isFrozen": false
}
```

#### Get Wallet Activity

```http
GET /api/v1/wallet/activity/:userId
```

**Response:**
```json
{
  "recentTransactions": [...],
  "pendingWithdrawals": 0,
  "thisMonthEarnings": 5000,
  "thisMonthWithdrawals": 2000
}
```

#### Get Transaction History

```http
GET /api/v1/wallet/transactions/:userId
```

#### Withdraw to Mobile Money

```http
POST /api/v1/wallet/withdraw/mobile-money
```

**Request Body:**
```json
{
  "userId": "user_456",
  "amount": 1000,
  "phone": "260971234567",
  "provider": "MTN",
  "description": "Withdrawal request"
}
```

**Flow:**
1. Validate balance and wallet status
2. Debit wallet immediately (pessimistic approach)
3. Initiate Lenco transfer
4. On failure: Mark withdrawal as failed (funds reversed)
5. Lenco webhook confirms completion

#### Withdraw to Bank

```http
POST /api/v1/wallet/withdraw/bank
```

**Request Body:**
```json
{
  "userId": "user_456",
  "amount": 1000,
  "bankCode": "ZB",
  "accountNumber": "1234567890",
  "accountName": "John Doe",
  "description": "Withdrawal request"
}
```

#### Top Up Wallet

```http
POST /api/v1/wallet/top-up
```

**Request Body:**
```json
{
  "userId": "user_456",
  "amount": 500,
  "paymentMethod": "mobile_money",
  "mobileNumber": "260971234567",
  "provider": "MTN"
}
```

#### Pay with Wallet

```http
POST /api/v1/wallet/pay
```

**Request Body:**
```json
{
  "userId": "user_456",
  "orderId": "order_123",
  "amount": 1500
}
```

#### Ensure Wallet Exists

```http
POST /api/v1/wallet/ensure/:userId
```

#### Get Platform Balance (Admin)

```http
GET /api/v1/wallet/platform/balance
```

---

### AI Endpoints

#### Get Product Recommendations

```http
POST /api/v1/ai/recommendations
```

**Request Body:**
```json
{
  "userId": "user_456",
  "limit": 10
}
```

**Response:**
```json
{
  "productIds": ["prod_1", "prod_2", "prod_3"],
  "reasoning": "Based on your interest in products..."
}
```

#### Find Similar Products

```http
POST /api/v1/ai/similar-products
```

**Request Body:**
```json
{
  "productId": "prod_123",
  "limit": 5
}
```

#### Analyze & Rephrase Message

```http
POST /api/v1/ai/rephrase-message
```

**Request Body:**
```json
{
  "message": "This product is garbage!",
  "senderRole": "buyer",
  "disputeContext": "Item not as described"
}
```

**Response:**
```json
{
  "original": "This product is garbage!",
  "rephrased": "I'm disappointed with the product quality as it doesn't match the description.",
  "isProfessional": false,
  "issues": ["hostile language"],
  "suggestions": ["Focus on specific issues", "Avoid emotional language"]
}
```

#### Analyze Dispute

```http
POST /api/v1/ai/analyze-dispute
```

**Request Body:**
```json
{
  "disputeId": "dispute_123",
  "viewerId": "user_456",
  "viewerRole": "buyer"
}
```

**Response:**
```json
{
  "summary": "You reported receiving a damaged item...",
  "keyPoints": {
    "buyerClaims": ["Item arrived damaged", "Packaging was inadequate"],
    "sellerClaims": ["Item was properly packaged", "Damage occurred during shipping"]
  },
  "sentiment": {
    "buyer": "frustrated",
    "seller": "cooperative"
  },
  "suggestedResolutions": [
    {
      "type": "partial_refund",
      "amount": 750,
      "reasoning": "Shared responsibility for shipping damage",
      "fairnessScore": 8
    }
  ],
  "recommendedAction": "Consider accepting a partial refund of K750",
  "riskLevel": "medium",
  "viewerRole": "buyer"
}
```

**Note:** Analysis is personalized to the viewer role (buyer/seller/moderator).

#### Generate Resolution Message

```http
POST /api/v1/ai/generate-resolution-message
```

#### General Chat

```http
POST /api/v1/ai/chat
```

**Request Body:**
```json
{
  "message": "How do I track my order?",
  "conversationHistory": [],
  "context": {
    "userId": "user_456",
    "currentScreen": "orders"
  }
}
```

**Response:**
```json
{
  "message": "To track your order, go to Orders and tap on the order...",
  "suggestions": ["View order details", "Contact seller"],
  "actions": [
    {
      "type": "navigate",
      "screen": "Orders"
    }
  ]
}
```

#### Suggest Responses

```http
POST /api/v1/ai/suggest-responses
```

#### Get Quick Actions

```http
GET /api/v1/ai/quick-actions?currentScreen=home
```

#### AI Health Check

```http
GET /api/v1/ai/health
```

---

## External Integrations

### 1. Convex Backend

**Purpose:** Primary database and real-time data layer

**Configuration:**
```env
CONVEX_URL=https://your-project.convex.cloud
```

**Integration:** HTTP-based client calling Convex's HTTP API endpoints (`/api/query`, `/api/mutation`)

### 2. Lenco Payment Gateway

**Purpose:** Payment processing for Zambian market

**Base URL:** `https://api.lenco.co/access/v2`

**Configuration:**
```env
LENCO_ACCOUNT_ID=your-account-id
LENCO_API_KEY=your-api-key
LENCO_SECRET_KEY=your-secret-key
```

**Supported Operations:**

| Operation | Endpoint | Description |
|-----------|----------|-------------|
| Mobile Money Collection | `POST /collections/mobile-money` | Receive payments via MTN, Airtel, Zamtel |
| Card Collection | `POST /collections/card` | Receive card payments |
| Mobile Money Transfer | `POST /transfers/mobile-money` | Send withdrawals |
| Bank Transfer | `POST /transfers/bank` | Send bank withdrawals |
| Account Resolution | `POST /resolve/mobile-money` | Verify mobile accounts |
| Bank Resolution | `POST /resolve/bank-account` | Verify bank accounts |
| Get Banks | `GET /banks` | List available banks |
| Account Balance | `GET /accounts/:id/balance` | Check platform balance |

**Webhook Signature Verification:**
- Algorithm: HMAC SHA512
- Header: `x-lenco-signature`
- Secret: `LENCO_SECRET_KEY`

### 3. OpenAI

**Purpose:** AI-powered features

**Configuration:**
```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini
```

**Features:**
- Product recommendations
- Message rephrasing and professionalism analysis
- Dispute analysis and resolution suggestions
- General chat assistance

**Fallback:** If AI is not configured, services return default values or random results.

---

## Payment Flows

### Payment Collection Flow

```
1. Client: POST /payments/mobile-money or /payments/card
                    ↓
2. API: Create Convex transaction record (status: pending)
                    ↓
3. API: Call Lenco collection API
                    ↓
4. API: Update transaction with Lenco IDs
                    ↓
5. API: Return authorization URL (card) or USSD prompt (mobile money)
                    ↓
6. User: Completes payment on phone/browser
                    ↓
7. Lenco: Sends webhook (collection.successful)
                    ↓
8. API: Webhook handler updates transaction status
                    ↓
9. If wallet top-up: Credit user's wallet
```

### Wallet Withdrawal Flow

```
1. Client: POST /wallet/withdraw/mobile-money or /bank
                    ↓
2. API: Validate balance & wallet status
                    ↓
3. API: Debit wallet (pessimistic - debit first)
                    ↓
4. API: Call Lenco transfer API
                    ↓
5. API: Update transaction with Lenco ID
                    ↓
6. On error: Mark withdrawal as failed (funds logically reversed)
                    ↓
7. Lenco: Sends webhook (transfer.successful)
                    ↓
8. API: Webhook handler marks transfer complete
```

### Dispute Analysis Flow

```
1. Client: POST /ai/analyze-dispute
                    ↓
2. API: Fetch dispute from Convex
                    ↓
3. API: Fetch dispute messages
                    ↓
4. API: Fetch pre-purchase conversation history (evidence)
                    ↓
5. API: Send to OpenAI with viewer role context
                    ↓
6. API: Save analysis to Convex
                    ↓
7. API: Return personalized analysis to viewer
```

---

## Error Handling

### HTTP Status Codes

| Code | Description | When Used |
|------|-------------|-----------|
| 400 | Bad Request | Validation failures, insufficient balance |
| 401 | Unauthorized | Invalid webhook signature |
| 403 | Forbidden | Frozen wallet |
| 404 | Not Found | Resource not found |
| 500 | Internal Server Error | Unexpected errors |
| 503 | Service Unavailable | Payment gateway not configured |

### Webhook Error Strategy

- Always returns `{ received: true }` to prevent Lenco retries
- Implements retry logic with exponential backoff (500ms, 1s, 2s)
- Logs errors but continues processing
- Max 3 retries for transaction updates

### Validation

Global validation pipe with:
- `whitelist: true` - Only pass decorated properties
- `forbidNonWhitelisted: true` - Reject unknown properties
- `transform: true` - Auto-transform to DTO class

---

## DTOs Reference

### Payment DTOs

```typescript
// Enums
enum PaymentMethod { MOBILE_MONEY, CARD, BANK_TRANSFER }
enum MobileMoneyProvider { MTN, AIRTEL, ZAMTEL }
enum TransactionStatus { PENDING, PROCESSING, SUCCESSFUL, FAILED, CANCELLED, REFUNDED }

// Request DTOs
interface InitiateMobileMoneyPaymentDto {
  orderId: string;
  userId: string;
  amount: number;        // min: 1
  provider: MobileMoneyProvider;
  mobileNumber: string;
  description?: string;
}

interface InitiateCardPaymentDto {
  orderId: string;
  userId: string;
  amount: number;
  email: string;
  description?: string;
  callbackUrl?: string;
}

// Wallet DTOs
interface WithdrawToMobileMoneyDto {
  userId: string;
  amount: number;        // min: 1
  phone: string;         // regex: ^260[0-9]{9}$
  provider: MobileMoneyProvider;
  description?: string;
}

interface PayWithWalletDto {
  userId: string;
  orderId: string;
  amount: number;
}
```

### AI DTOs

```typescript
interface GetRecommendationsDto {
  userId: string;
  limit?: number;        // 1-50, default: 10
}

interface RephraseMessageDto {
  message: string;       // 1-2000 chars
  senderRole: 'buyer' | 'seller' | 'moderator';
  disputeContext?: string;  // max 500 chars
}

interface AnalyzeDisputeDto {
  disputeId: string;
  viewerId: string;
  viewerRole: 'buyer' | 'seller' | 'moderator';
}

interface ChatRequestDto {
  message: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  context?: {
    userId?: string;
    currentScreen?: string;
    productId?: string;
    orderId?: string;
  };
}
```

---

## Deployment Notes

### CORS Configuration

Configure allowed origins in environment:
```env
CORS_ORIGINS=https://your-web-app.com,https://your-mobile-app.com
```

### Security Considerations

1. **Webhook Verification:** Always verify Lenco webhook signatures
2. **Input Validation:** All inputs are validated via DTOs
3. **Phone Validation:** Zambian phone numbers must match `^260[0-9]{9}$`
4. **No Auth Guards:** API relies on frontend authentication (Clerk)

### Monitoring

- Health endpoints for load balancers
- Swagger documentation for API testing
- Comprehensive error logging

---

## Troubleshooting

### Common Issues

1. **Payment webhook not processing**
   - Check webhook signature verification
   - Ensure `LENCO_SECRET_KEY` is correct
   - Check webhook URL is accessible

2. **AI features returning empty results**
   - Verify `OPENAI_API_KEY` is set
   - Check API rate limits

3. **Convex connection errors**
   - Verify `CONVEX_URL` is correct
   - Check Convex deployment status

4. **Wallet operations failing**
   - Check if wallet exists (`POST /wallet/ensure/:userId`)
   - Verify wallet is not frozen

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024 | Initial release |
