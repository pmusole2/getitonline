import type { FunctionArgs } from 'convex/server';

import type { api } from '../../../../convex/_generated/api';

export type MobileMoneyProvider = FunctionArgs<typeof api.checkoutCollection.initiateCheckoutCollection>['operator'];
