"use client";

import { useQueries } from "convex/react";
import { useMemo } from "react";
import {
  resolvePaymentAvailability,
  type PaymentAvailability,
} from "@gettitonline/shared";
import { api } from "../../../../convex/_generated/api";

// Fails closed. A loading, failed, or malformed result counts as unavailable, so payment actions stay disabled.
// A failed query is returned as an Error value rather than thrown, so it shows the unavailable state, not the error page.
export function usePaymentAvailability(): PaymentAvailability {
  // Memoized, because useQueries keys its subscription on the request object's identity, and a new object on every
  // render would re-subscribe on every render.
  const requests = useMemo(
    () => ({
      availability: { query: api.appConfig.getPaymentAvailability, args: {} },
    }),
    [],
  );
  const results = useQueries(requests);
  const result: unknown = results.availability;
  return result instanceof Error
    ? "unavailable"
    : resolvePaymentAvailability(result);
}
