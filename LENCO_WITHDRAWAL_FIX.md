# Lenco Withdrawal Error Fix - December 1, 2025

## Issues Identified and Fixed

### 1. **Status Validation Error (Root Cause)**
**Problem:** The error in your terminal showed:
```
ArgumentValidationError: Value does not match validator.
Path: .status
Value: "pending"
Validator: v.union(v.literal("completed"), v.literal("failed"), v.literal("cancelled"))
```

**Root Cause:** In `convex.service.ts`, the `updateWalletTransactionExternal()` method was calling `updateWithdrawalStatus` mutation with `status: 'pending'`, but that mutation only accepts `"completed"`, `"failed"`, or `"cancelled"`.

**Fix:** Created a new mutation `updateTransactionExternalReference` in `convex/wallet.ts` that:
- Only updates the external reference (Lenco transaction ID)
- Does NOT change the transaction status
- Keeps the transaction in "pending" state until the webhook updates it

### 2. **Improved Lenco API Logging**
**Problem:** When Lenco API calls failed, the error details were not visible, making it hard to debug.

**Fix:** Enhanced `lenco.service.ts` `makeRequest()` method with comprehensive logging:
- 📤 Logs all outgoing requests with method, endpoint, and body
- 📥 Logs all responses with status code and full response body
- ❌ Logs detailed error responses including status text
- Better error handling with context

### 3. **Enhanced Withdrawal Logging**
**Problem:** When withdrawal requests failed, it was unclear where exactly the failure occurred.

**Fix:** Added detailed logging to both `withdrawToMobileMoney()` and `withdrawToBank()` in `wallet.controller.ts`:
- 💳 Logs withdrawal initiation with parameters
- 💳 Logs Lenco response receipt
- ✅ Logs successful transaction updates
- ❌ Logs detailed error information with stack traces
- ✅ Logs transaction status updates with results

## Files Changed

### 1. `/apps/api/src/payments/services/lenco.service.ts`
- Enhanced `makeRequest<T>()` method with comprehensive logging for all API calls

### 2. `/apps/api/src/payments/wallet.controller.ts`
- Added detailed logging to `withdrawToMobileMoney()` endpoint
- Added detailed logging to `withdrawToBank()` endpoint
- Improved error handling with try-catch around status updates

### 3. `/convex/wallet.ts`
- Added new mutation: `updateTransactionExternalReference`
  - Updates only the externalReference field
  - Preserves transaction status as-is

### 4. `/apps/api/src/convex/convex.service.ts`
- Updated `updateWalletTransactionExternal()` to use new mutation
- Changed from calling `updateWithdrawalStatus` (which validates status) to calling `updateTransactionExternalReference`

## How It Works Now

### Withdrawal Flow:
1. User requests withdrawal (mobile money or bank)
2. Wallet is debited (transaction created with `status: "pending"`)
3. Lenco API call is initiated with detailed request logging
4. Lenco response is logged (ID and status)
5. **NEW:** Transaction external reference is updated WITHOUT changing status
6. Transaction waits for webhook callback with final status
7. Webhook updates transaction to "completed" or "failed"

### Error Flow:
1. If Lenco API call fails, error is logged with full details
2. Transaction status is explicitly updated to "failed"
3. Wallet funds are reversed (re-credited)
4. User is notified
5. All errors logged with context

## Testing the Fix

To verify the fix works:

1. **Mobile Money Withdrawal:**
   ```
   POST /api/v1/wallet/withdraw/mobile-money
   {
     "userId": "...",
     "phone": "[ZAMBIAN_MOBILE_NUMBER]",
     "provider": "airtel",
     "amount": 50,
     "description": "Test withdrawal"
   }
   ```

2. **Bank Withdrawal:**
   ```
   POST /api/v1/wallet/withdraw/bank
   {
     "userId": "...",
     "bankCode": "...",
     "accountNumber": "...",
     "accountName": "...",
     "amount": 50,
     "description": "Test withdrawal"
   }
   ```

3. **Check Logs:**
   - Look for 📤 request logs
   - Look for 📥 response logs
   - Look for ❌ error logs with full error details
   - Look for ✅ success logs with transaction IDs

## Environment Variables Required

Ensure these are set in your `.env` file:
- `LENCO_API_KEY` - Your Lenco API key
- `LENCO_SECRET_KEY` - Your Lenco secret key
- `LENCO_ACCOUNT_ID` - Your Lenco account ID
- `LENCO_BASE_URL` - (optional) Defaults to `https://api.lenco.co/access/v2`

## API Automatically Reloads

Since the API runs in `npm run start:dev` mode, changes are automatically picked up. You should see:
```
[HH:MM:SS AM] File change detected. Starting incremental compilation...
[HH:MM:SS AM] Found 0 errors. Watching for file changes.
```

## Next Steps

1. Test a withdrawal request to verify the fix
2. Check the API logs for proper logging
3. Monitor the Lenco webhook callbacks for status updates
4. If issues persist, the detailed logs will show exactly what Lenco returns
