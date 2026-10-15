import AsyncStorage from '@react-native-async-storage/async-storage';
import { isHttpsStoreUrl } from '@gettitonline/shared';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  readNativeBuild,
  useAppResumeCount,
  useClientGate,
  type ClientGateDecision,
  type NativeBuild,
  type UpdateRequiredDecision,
} from '../hooks/useClientGate';
import { ClientGateBoundary } from './ClientGateBoundary';
import { UpdateRequiredScreen } from './UpdateRequiredScreen';

interface ClientGateProps {
  readonly children: ReactNode;
}

// The last update-required decision, saved so a cold start with the network down keeps a known-incompatible build blocked.
// The platform and build are stored in the value, so a newer installed build, or the same build number on the other
// platform, ignores a record saved for something else.
const BLOCKED_BUILD_STORAGE_KEY = 'gettitonline.clientGate.blockedBuild.v1';
const openDecision: ClientGateDecision = { status: 'ok' };
// The longest the app waits for the saved block before it opens. A read that never answers must not hold launch.
const HYDRATION_HOLD_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Returns the saved block only when it is for this installed build and platform. A read or parse failure is no saved
// block, so the app opens. Storage that cannot be read must never block launch on its own.
async function readBlockedBuild(native: NativeBuild): Promise<UpdateRequiredDecision | null> {
  try {
    const raw = await AsyncStorage.getItem(BLOCKED_BUILD_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const saved: unknown = JSON.parse(raw);
    if (!isRecord(saved) || saved.build !== native.build || saved.platform !== native.platform) {
      return null;
    }
    const { minimumBuild, storeUrl } = saved;
    if (typeof minimumBuild !== 'number' || !Number.isSafeInteger(minimumBuild) || minimumBuild < 0) {
      return null;
    }
    return { status: 'update-required', minimumBuild, storeUrl: isHttpsStoreUrl(storeUrl) ? storeUrl : null };
  } catch {
    return null;
  }
}

async function saveBlockedBuild(native: NativeBuild, decision: UpdateRequiredDecision): Promise<void> {
  try {
    await AsyncStorage.setItem(
      BLOCKED_BUILD_STORAGE_KEY,
      JSON.stringify({
        platform: native.platform,
        build: native.build,
        minimumBuild: decision.minimumBuild,
        storeUrl: decision.storeUrl,
      }),
    );
  } catch {
    // A failed save only means a cold start cannot keep the block. The live decision still applies.
  }
}

async function clearBlockedBuild(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BLOCKED_BUILD_STORAGE_KEY);
  } catch {
    // A failed clear leaves a record that a later successful check overwrites or clears.
  }
}

function sameDecision(current: ClientGateDecision, next: ClientGateDecision): boolean {
  if (current.status === 'ok' || next.status === 'ok') {
    return current.status === next.status;
  }
  return current.minimumBuild === next.minimumBuild && current.storeUrl === next.storeUrl;
}

// Fails open until a decision is known, and then keeps the last one. A loading, failed, or malformed check says nothing
// new, so it never clears a block. Only a successful result that says the build is acceptable clears it.
// The app content is held, not shown, until the saved block has been read or a server result has settled, or the
// hold times out. So no protected effect runs before a block that was saved earlier is known.
export function ClientGate({ children }: ClientGateProps) {
  const [decision, setDecision] = useState<ClientGateDecision>(openDecision);
  const resumeCount = useAppResumeCount();
  const [native] = useState(() => readNativeBuild());
  // Set once a server result has settled this session. A saved-block read that finishes later must not override it.
  const serverSettled = useRef(false);
  // A build that cannot be identified has nothing to hold for, so the app opens at once.
  const [released, setReleased] = useState(native === null);

  useEffect(() => {
    if (native === null) {
      return undefined;
    }
    let active = true;
    void readBlockedBuild(native).then((saved) => {
      if (!active) {
        return;
      }
      if (saved !== null && !serverSettled.current) {
        setDecision(saved);
      }
      setReleased(true);
    });
    return () => {
      active = false;
    };
  }, [native]);

  useEffect(() => {
    if (released) {
      return undefined;
    }
    const timer = setTimeout(() => setReleased(true), HYDRATION_HOLD_MS);
    return () => clearTimeout(timer);
  }, [released]);

  const handleSettled = useCallback(
    (next: ClientGateDecision) => {
      serverSettled.current = true;
      setReleased(true);
      setDecision((current) => (sameDecision(current, next) ? current : next));
      if (native === null) {
        return;
      }
      if (next.status === 'ok') {
        void clearBlockedBuild();
      } else {
        void saveBlockedBuild(native, next);
      }
    },
    [native],
  );

  let content: ReactNode = null;
  if (decision.status === 'update-required') {
    content = <UpdateRequiredScreen storeUrl={decision.storeUrl} />;
  } else if (released) {
    content = children;
  }

  return (
    <>
      <ClientGateBoundary key={resumeCount}>
        <ClientGateProbe onSettled={handleSettled} />
      </ClientGateBoundary>
      {content}
    </>
  );
}

function ClientGateProbe({ onSettled }: { readonly onSettled: (decision: ClientGateDecision) => void }) {
  const observation = useClientGate();
  // The effect depends on primitives, so it reports a decision only when the settled decision itself changes.
  const settled = observation.status === 'settled' ? observation.decision : null;
  const settledStatus = settled?.status ?? 'pending';
  const minimumBuild = settled?.status === 'update-required' ? settled.minimumBuild : null;
  const storeUrl = settled?.status === 'update-required' ? settled.storeUrl : null;

  useEffect(() => {
    if (settledStatus === 'pending') {
      return;
    }
    onSettled(
      settledStatus === 'ok' || minimumBuild === null
        ? openDecision
        : { status: 'update-required', minimumBuild, storeUrl },
    );
  }, [settledStatus, minimumBuild, storeUrl, onSettled]);

  return null;
}
