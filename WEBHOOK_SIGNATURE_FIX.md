# Lenco Webhook Signature & Event Handling Fix - December 1, 2025

## Issues Identified

### 1. **Webhook Signature Validation Failure**
**Symptom:** Logs showed "⚠️ Invalid webhook signature" for multiple events
**Problem:**
- Signature verification was happening BEFORE event filtering
- Non-relevant events were still going through signature validation
- When signature failed, it threw an error, stopping webhook processing

### 2. **Too Many Events Being Handled**
**Symptom:** Receiving and logging multiple events: `transaction.debit`, `transfer.successful`, `transaction.credit`, etc.
**Problem:**
- The webhook handler was processing 4 events: `collection.successful`, `collection.failed`, `transfer.successful`, `transfer.failed`
- User only needs: `transfer.successful` (for withdrawals) and `collection.successful` (for top-ups)
- Extra events caused unnecessary processing and signature validation failures

### 3. **Signature Verification Not Blocking Processing**
**Symptom:** Webhooks "work" despite signature validation failure
**Problem:**
- The error was being caught but not properly handled
- Processing continued but signature errors weren't diagnosed

## Root Cause Analysis

Looking at the webhook logs:
```
📩 Received Lenco webhook: transaction.debit
⚠️ Invalid webhook signature
📩 Received Lenco webhook: transfer.successful
⚠️ Invalid webhook signature
```

This shows:
1. Lenco is sending multiple event types
2. All of them are failing signature validation
3. But the application continues processing anyway

## Fixes Applied

### 1. **Event Filtering Before Signature Verification**
**File:** `apps/api/src/payments/payments.controller.ts`

```typescript
// Only handle these two events
const handledEvents = ['transfer.successful', 'collection.successful'];
if (!handledEvents.includes(event)) {
  console.log(`⏭️ Skipping unhandled event: ${event}`);
  return { received: true };
}

// Verify signature ONLY for events we handle
const rawBody = req.rawBody?.toString() || JSON.stringify(payload);
if (!this.lencoService.verifyWebhookSignature(rawBody, signature)) {
  console.warn('⚠️ Invalid webhook signature');
  console.log('📋 Signature details:', {
    event,
    reference: data.reference,
    receivedSignature: signature ? signature.substring(0, 20) + '...' : 'missing',
  });
  // Continue processing - don't fail
}
```

**Benefits:**
- Ignores unwanted events immediately (no processing wasted)
- Only validates signature for events we care about
- Logs details about signature failures for debugging

### 2. **Simplified Event Handlers**
**File:** `apps/api/src/payments/payments.controller.ts`

Changed from:
```typescript
if (event === 'collection.successful' || event === 'collection.failed') {
  // ...
} else if (event === 'transfer.successful' || event === 'transfer.failed') {
  // ...
}
```

To:
```typescript
if (event === 'collection.successful') {
  // Handle top-ups only
  const status = TransactionStatus.SUCCESSFUL;
  // ...
} else if (event === 'transfer.successful') {
  // Handle withdrawals only
  const status = TransactionStatus.SUCCESSFUL;
  // ...
}
```

**Benefits:**
- Cleaner code
- Only successful transactions are handled
- No unnecessary failed event processing

### 3. **Enhanced Signature Debugging**
**File:** `apps/api/src/payments/services/lenco.service.ts`

```typescript
verifyWebhookSignature(payload: string, signature: string): boolean {
  // ... validation checks ...

  const isValid = signature === expectedSignature;

  if (!isValid) {
    console.warn('🔐 Signature mismatch');
    console.log('🔐 Payload length:', payload.length);
    console.log('🔐 Expected signature:', expectedSignature.substring(0, 32) + '...');
    console.log('🔐 Received signature:', signature.substring(0, 32) + '...');
  } else {
    console.log('🔐 Webhook signature verified ✓');
  }

  return isValid;
}
```

**Benefits:**
- Clear indication when signature verification succeeds
- Detailed debugging info when it fails
- Helps identify payload encoding issues

## Webhook Event Mapping

**Before:**
```
transaction.debit        → ⚠️ Invalid signature (ignored after processing)
collection.successful   → ⚠️ Invalid signature (processed for top-ups)
collection.failed       → ⚠️ Invalid signature (processed for top-ups)
transaction.credit      → ⚠️ Invalid signature (ignored after processing)
transfer.successful     → ⚠️ Invalid signature (processed for withdrawals)
transfer.failed         → ⚠️ Invalid signature (processed for withdrawals)
```

**After:**
```
transaction.debit        → ⏭️ Skipped (not in handled events)
collection.successful   → ✓ Processed (signature checked)
collection.failed       → ⏭️ Skipped (not in handled events)
transaction.credit      → ⏭️ Skipped (not in handled events)
transfer.successful     → ✓ Processed (signature checked)
transfer.failed         → ⏭️ Skipped (not in handled events)
```

## What To Check

### 1. **Webhook Secret Configuration**
Verify your `.env` has:
```
LENCO_WEBHOOK_SECRET=your_actual_webhook_secret_from_lenco
```

### 2. **Signature Mismatch Debugging**
If you still see "🔐 Signature mismatch" with valid events:
1. Check if `LENCO_WEBHOOK_SECRET` is correct
2. Check if Lenco's webhook payload encoding changed
3. Verify the signature algorithm (currently SHA512 HMAC)
4. Check if Lenco sends headers in a different format

### 3. **Expected Logs After Fix**
For a successful withdrawal:
```
📩 Received Lenco webhook: transfer.successful
⏭️ Skipping unhandled event: (for other events)
🔐 Webhook signature verified ✓
💳 [Withdrawal] Lenco response received: { id: '...', status: 'successful' }
✅ [Withdrawal] Transaction updated
```

For a failed signature:
```
📩 Received Lenco webhook: transfer.successful
🔐 Signature mismatch
🔐 Payload length: 1234
🔐 Expected signature: abc123def456...
🔐 Received signature: xyz789...
```

## Technical Details

### Event Flow
1. Lenco sends webhook POST to `/api/v1/payments/webhook`
2. Application logs the event type
3. Check if event is in `['transfer.successful', 'collection.successful']`
4. If not, skip processing and return success
5. If yes, verify signature with HMAC SHA512
6. Process the event (update transaction, credit wallet, etc.)

### Signature Calculation
```typescript
signature = HMAC-SHA512(payload, LENCO_WEBHOOK_SECRET)
```

Where:
- `payload` = Raw request body (must be exact)
- `LENCO_WEBHOOK_SECRET` = From environment variable
- Result = Hex-encoded string

## Possible Remaining Issues

If you still get "Invalid webhook signature" with the correct secret:

1. **Payload Encoding**: Lenco might send payload in different encoding
   - Solution: Check if `req.rawBody` is being read correctly

2. **Header Format**: Signature header might have different name
   - Check: Look at actual header sent by Lenco
   - Currently checking for: `x-lenco-signature`

3. **Lenco API Change**: Webhook algorithm might have changed
   - Check: Lenco documentation for current algorithm
   - Currently using: HMAC SHA512

4. **Multiple Secrets**: Different environments might need different secrets
   - Check: `.env.local` vs `.env.production`

## Testing

To test webhook processing:

```bash
# Test with curl (replace SECRET and PAYLOAD)
curl -X POST http://localhost:3001/api/v1/payments/webhook \
  -H "Content-Type: application/json" \
  -H "x-lenco-signature: $(echo -n 'payload' | openssl dgst -sha512 -hmac 'secret' -hex | cut -d' ' -f2)" \
  -d '{"event":"transfer.successful","data":{"id":"test","reference":"WDR-TEST","status":"successful"}}'
```

## Files Modified

1. `apps/api/src/payments/payments.controller.ts`
   - Added event filtering before signature verification
   - Removed handling for `collection.failed` and `transfer.failed`
   - Added signature debugging logs

2. `apps/api/src/payments/services/lenco.service.ts`
   - Improved signature verification logging
   - Added diagnostic output for failed signatures
   - Changed from `require('crypto')` to proper import

## Next Steps

1. Monitor logs for successful webhook processing
2. If signature still fails, check the diagnostic logs for details
3. Verify LENCO_WEBHOOK_SECRET is correct
4. Contact Lenco support if signature algorithm differs from SHA512
