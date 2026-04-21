# Gettitonline

Gettitonline is a monorepo for an escrow-based marketplace focused on mobile-first beta delivery.

## What is in this repo

- `apps/mobile`: Expo / React Native app for the iOS beta and TestFlight builds
- `apps/api`: NestJS sidecar for payments, webhooks, and AI integrations
- `apps/web`: Next.js admin and parity surface for browser-based flows
- `convex`: primary backend data model, queries, mutations, and storage
- `packages/shared`: shared schemas, types, and formatting utilities

## Accounts and services required

- Clerk
- Convex
- OpenAI
- Lenco
- Expo / EAS
- Railway

## Environment variables

### Mobile

See [apps/mobile/.env.example](/Users/macbookair/Desktop/Auto%20Marketplace/apps/mobile/.env.example).

### API

See [apps/api/.env.example](/Users/macbookair/Desktop/Auto%20Marketplace/apps/api/.env.example).

### Web

See [apps/web/.env.local.example](/Users/macbookair/Desktop/Auto%20Marketplace/apps/web/.env.local.example).

## Local startup order

1. Install dependencies with `npm ci`
2. Configure app-specific env files from the examples
3. Start Convex with `npm run db:dev`
4. Start the API with `npm run api`
5. Start the mobile app with `npm run mobile`
6. Start the web app with `npm run dev --workspace=apps/web`

## Verification commands

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run verify`

`npm run verify` is the release gate for this repo. It runs typecheck, lint, tests, API build, and web build.

## Deployment

### Railway API

- Railway config lives in [railway.json](/Users/macbookair/Desktop/Auto%20Marketplace/railway.json)
- Health check path: `/api/v1/health/ready`
- Start command: `npm run start:prod --workspace=apps/api`

Required production API env:

- `PORT`
- `CONVEX_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `CORS_ORIGINS`
- `APP_URL`
- `LENCO_ACCOUNT_ID`
- `LENCO_API_KEY`
- `LENCO_SECRET_KEY`
- `LENCO_WEBHOOK_SECRET`
- `LENCO_BASE_URL`

### TestFlight

- Expo config is driven by [apps/mobile/app.config.ts](/Users/macbookair/Desktop/Auto%20Marketplace/apps/mobile/app.config.ts)
- EAS profiles live in [apps/mobile/eas.json](/Users/macbookair/Desktop/Auto%20Marketplace/apps/mobile/eas.json)
- Set `EAS_PROJECT_ID` before running a preview or production build

Typical internal beta flow:

1. `cd apps/mobile`
2. `EAS_PROJECT_ID=your-project-id npx eas build --platform ios --profile preview`
3. Install the build internally or submit through `npx eas submit --platform ios --profile production`

## Critical release checklist

See [docs/RELEASE_CHECKLIST.md](/Users/macbookair/Desktop/Auto%20Marketplace/docs/RELEASE_CHECKLIST.md).

## Detailed implementation notes

- [docs/MOBILE_APP_IMPLEMENTATION.md](/Users/macbookair/Desktop/Auto%20Marketplace/docs/MOBILE_APP_IMPLEMENTATION.md)
- [docs/API_IMPLEMENTATION.md](/Users/macbookair/Desktop/Auto%20Marketplace/docs/API_IMPLEMENTATION.md)
- [apps/api/README.md](/Users/macbookair/Desktop/Auto%20Marketplace/apps/api/README.md)
- [apps/web/README.md](/Users/macbookair/Desktop/Auto%20Marketplace/apps/web/README.md)
