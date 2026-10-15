// Clerk JWT validation for Convex. The issuer domain comes from the Clerk
// dashboard's "convex" JWT template and is set per deployment. A missing value
// fails the deploy instead of falling back to an unauthenticated configuration.
const domain = process.env.CLERK_JWT_ISSUER_DOMAIN?.trim();
if (!domain) {
  throw new Error("CLERK_JWT_ISSUER_DOMAIN is not configured.");
}

export default {
  providers: [
    {
      domain,
      applicationID: "convex",
    },
  ],
};
