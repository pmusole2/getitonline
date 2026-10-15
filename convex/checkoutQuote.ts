import { query } from "./_generated/server";
import { requireUser } from "./lib/auth";
import {
  QuoteError,
  QuoteMismatchError,
  computeCheckoutQuote,
  quoteRequestValidator,
  quoteResultValidator,
} from "./lib/checkoutQuote";

// Read-only authoritative checkout quote. Requires the verified caller first,
// then prices the caller's own cart or owned pending orders from current
// records. This query never writes and never calls a provider. Auth denials
// throw from the shared guard; business denials return a stable code.
export const quoteCheckout = query({
  args: quoteRequestValidator,
  returns: quoteResultValidator,
  handler: async (ctx, args) => {
    const actor = await requireUser(ctx);
    try {
      const quote = await computeCheckoutQuote(ctx, actor, args);
      return { ok: true as const, quote };
    } catch (error) {
      if (error instanceof QuoteMismatchError) {
        return { ok: false as const, code: "quote_mismatch" as const, quote: error.quote };
      }
      if (error instanceof QuoteError) {
        return { ok: false as const, code: error.code };
      }
      throw error;
    }
  },
});
