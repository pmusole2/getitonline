# Gettitonline API

NestJS sidecar for:

- Lenco payment initiation
- Lenco webhook handling and signature verification
- OpenAI-backed AI endpoints
- HTTP bridge calls into Convex

## Local development

1. Copy values from [.env.example](/Users/macbookair/Desktop/Auto%20Marketplace/apps/api/.env.example)
2. Run `npm run start:dev --workspace=apps/api`
3. Open Swagger at `http://localhost:3001/docs`

## Verification

- `npm run typecheck --workspace=apps/api`
- `npm run lint --workspace=apps/api`
- `npm run test --workspace=apps/api`
- `npm run build --workspace=apps/api`

## Railway

Railway reads config from [railway.json](/Users/macbookair/Desktop/Auto%20Marketplace/railway.json).

Runtime expectations:

- health check: `/api/v1/health/ready`
- start command: `npm run start:prod --workspace=apps/api`
- `APP_URL` must point at the deployed public application callback base
- `LENCO_WEBHOOK_SECRET` must be set for production webhook verification

## Notes

- Convex remains the system of record for marketplace data.
- This API is the integration boundary for payment providers, AI, and webhook processing.
