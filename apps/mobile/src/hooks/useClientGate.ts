import { useQueries, type RequestForQueries } from 'convex/react';
import Constants from 'expo-constants';
import { nativeBuildVersion } from 'expo-application';
import { useEffect, useMemo, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { readClientGateContract } from '@gettitonline/shared';

import { api } from '../../../../convex/_generated/api';

export interface UpdateRequiredDecision {
  readonly status: 'update-required';
  readonly minimumBuild: number;
  readonly storeUrl: string | null;
}

export type ClientGateDecision = { readonly status: 'ok' } | UpdateRequiredDecision;

// 'pending' means the check has not settled for this build: it is loading, failed, or returned a malformed result.
// It says nothing new, so the gate keeps the decision it already holds.
export type ClientGateObservation =
  | { readonly status: 'pending' }
  | { readonly status: 'settled'; readonly decision: ClientGateDecision };

export interface NativeBuild {
  readonly platform: 'ios' | 'android';
  readonly build: number;
}

// Accepts only a positive whole number, so '', '0', '1.5', '-3', and '42abc' never reach the server as a build.
function parseBuildNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const text = String(value);
  const parsed = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(parsed) ? parsed : null;
}

// Under remote app versioning the app config has no build number, so this is only a fallback for the native value.
function appConfigBuild(platform: 'ios' | 'android'): unknown {
  return platform === 'ios' ? Constants.expoConfig?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode;
}

// The build this binary was shipped with. The native build number is the source of truth; the app config is a fallback.
// Null means no usable build number exists on either source, so the version check is skipped.
export function readNativeBuild(): NativeBuild | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return null;
  }
  const build = parseBuildNumber(nativeBuildVersion) ?? parseBuildNumber(appConfigBuild(Platform.OS));
  return build === null ? null : { platform: Platform.OS, build };
}

// The request for a build that is not checked. One shared object, so it keeps its identity across renders too.
const noGateRequest: RequestForQueries = {};
const pending: ClientGateObservation = { status: 'pending' };
const openSettled: ClientGateObservation = { status: 'settled', decision: { status: 'ok' } };

// Reads the version gate for this build. It is public, so it needs no session and never waits on auth.
// A build that cannot be identified is not checked. A loading, failed, or malformed result stays pending, and the caller
// keeps its last decision. useQueries returns a failed query as an Error value rather than throwing.
export function useClientGate(): ClientGateObservation {
  const native = readNativeBuild();
  const platform = native?.platform;
  const build = native?.build;
  // The whole request object is memoized. useQueries keys its subscription on this object's identity, so a new object on
  // every render re-subscribes on every render and loops. The memo depends only on primitives, so it holds across renders.
  const requests = useMemo(
    () =>
      platform === undefined || build === undefined
        ? noGateRequest
        : { gate: { query: api.appConfig.getClientGate, args: { platform, build } } },
    [platform, build],
  );
  const results = useQueries(requests);
  const result: unknown = results.gate;

  if (native === null) {
    return openSettled;
  }
  if (result === undefined || result instanceof Error) {
    return pending;
  }
  const contract = readClientGateContract(result);
  if (contract === null) {
    return pending;
  }
  if (!contract.updateRequired) {
    return openSettled;
  }
  return {
    status: 'settled',
    decision: { status: 'update-required', minimumBuild: contract.minimumBuild, storeUrl: contract.storeUrl },
  };
}

// Counts each return to the foreground. Keying a component by this count remounts it, which re-subscribes the gate
// query. Query args are not used for this, because the server validates them.
export function useAppResumeCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous !== 'active' && next === 'active') {
        setCount((current) => current + 1);
      }
      previous = next;
    });
    return () => subscription.remove();
  }, []);

  return count;
}
