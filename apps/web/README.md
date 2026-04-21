# Gettitonline Web

Next.js web surface for browsing, checkout parity, seller flows, and admin support.

For this beta cycle, web is maintained for correctness and internal validation, but the public release focus is `iOS + API`.

## Local development

1. Copy values from [.env.local.example](/Users/macbookair/Desktop/Auto%20Marketplace/apps/web/.env.local.example)
2. Run `npm run dev --workspace=apps/web`

## Verification

- `npm run typecheck --workspace=apps/web`
- `npm run lint --workspace=apps/web`
- `npm run build --workspace=apps/web`

## Important implementation notes

- Listing image uploads now use Convex storage, not demo placeholder URLs.
- The web app depends on Clerk and Convex env being configured correctly.
- The current Next.js `middleware` file still builds, but Next 16 warns that `proxy` is the preferred convention.
