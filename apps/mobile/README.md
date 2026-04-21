# Gettitonline Mobile

Expo / React Native app for the iOS beta and TestFlight distribution.

## Local development

1. Copy values from [.env.example](/Users/macbookair/Desktop/Auto%20Marketplace/apps/mobile/.env.example)
2. Run `npm run start --workspace=apps/mobile`
3. Use `npm run ios --workspace=apps/mobile` for the native iOS project

## Verification

- `npm run typecheck --workspace=apps/mobile`

## EAS / TestFlight

- App config is defined in [app.config.ts](/Users/macbookair/Desktop/Auto%20Marketplace/apps/mobile/app.config.ts)
- Build profiles are defined in [apps/mobile/eas.json](/Users/macbookair/Desktop/Auto%20Marketplace/apps/mobile/eas.json)
- `EAS_PROJECT_ID` must be set before requesting push tokens or running cloud builds
