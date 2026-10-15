import { useQueries } from 'convex/react';
import { useMemo } from 'react';
import { resolvePaymentAvailability, type PaymentAvailability } from '@gettitonline/shared';

import { api } from '../../../../convex/_generated/api';

// Fails closed. A loading, failed, or malformed result counts as unavailable, so entry points never open early.
// A failed query is returned as an Error value rather than thrown, so it shows the unavailable state, not the error screen.
export function usePaymentAvailability(): PaymentAvailability {
  // Memoized, because useQueries keys its subscription on the request object's identity (see useClientGate).
  const requests = useMemo(() => ({ availability: { query: api.appConfig.getPaymentAvailability, args: {} } }), []);
  const results = useQueries(requests);
  const result: unknown = results.availability;
  return result instanceof Error ? 'unavailable' : resolvePaymentAvailability(result);
}
