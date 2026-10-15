import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import { resolveAccountAccess, type AccountAccessStatus } from '@gettitonline/shared';

import { useAppAuth } from '../../context/AuthProvider';
import type { RootStackParamList } from '../../types';

export interface AccountAccessControl {
  readonly status: AccountAccessStatus;
  readonly signIn: () => void;
  readonly retry: () => void;
  readonly signOut: () => Promise<void>;
  readonly goBack: () => void;
}

// Protected screens render their content only when the account is ready. Every other state gets an
// actionable notice, and the content (with its queries) is never mounted.
export function useAccountAccess(): AccountAccessControl {
  const { isLoading, isSignedIn, user, authSyncError, retryUserSync, signOut } = useAppAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return {
    status: resolveAccountAccess({
      isLoading,
      isSignedIn,
      syncFailed: authSyncError !== null,
      user,
    }),
    signIn: () => navigation.navigate('Auth'),
    retry: retryUserSync,
    signOut: () => signOut(),
    goBack: () => navigation.goBack(),
  };
}
