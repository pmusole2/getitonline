import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, Linking } from 'react-native';
import {
  AI_CONSENT_VERSION,
  createAIConsentRecord,
  getAIConsentDisclosure,
  isAIConsentRecordForSubject,
  type AIConsentRecord,
  type AIConsentSubject,
} from './aiConsentPolicy';

export { AI_CONSENT_VERSION, getAIConsentDisclosure } from './aiConsentPolicy';
export type { AIConsentRecord, AIConsentSubject } from './aiConsentPolicy';

export const AI_PRIVACY_POLICY_URL =
  'https://www.gettitonline.com/getitonline-privacy-policy/';

const AI_CONSENT_STORAGE_KEY = 'gettitonline.aiConsent.v2';
let activeConsentSubject: AIConsentSubject = 'guest';

export class AIConsentRequiredError extends Error {
  constructor() {
    super('AI consent is required before using Gettitonline AI features.');
    this.name = 'AIConsentRequiredError';
  }
}

export function setAIConsentSubject(subject: AIConsentSubject): void {
  activeConsentSubject = subject;
}

function parseConsentRecord(
  rawValue: string | null,
  subject: AIConsentSubject,
): AIConsentRecord | null {
  if (!rawValue) return null;

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (isAIConsentRecordForSubject(parsed, subject)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export async function getAIConsentRecord(
  subject = activeConsentSubject,
): Promise<AIConsentRecord | null> {
  const rawValue = await AsyncStorage.getItem(AI_CONSENT_STORAGE_KEY);
  return parseConsentRecord(rawValue, subject);
}

export async function hasAIConsent(
  subject = activeConsentSubject,
): Promise<boolean> {
  return (await getAIConsentRecord(subject)) !== null;
}

export async function acceptAIConsent(
  subject = activeConsentSubject,
): Promise<AIConsentRecord> {
  const record = createAIConsentRecord(subject);

  await AsyncStorage.setItem(AI_CONSENT_STORAGE_KEY, JSON.stringify(record));
  return record;
}

export async function revokeAIConsent(): Promise<void> {
  await AsyncStorage.removeItem(AI_CONSENT_STORAGE_KEY);
}

export async function requireAIConsent(
  subject = activeConsentSubject,
): Promise<void> {
  if (!(await hasAIConsent(subject))) {
    throw new AIConsentRequiredError();
  }
}

export async function requestAIConsent(): Promise<boolean> {
  const requestedSubject = activeConsentSubject;
  if (await hasAIConsent(requestedSubject)) {
    return true;
  }

  const disclosure = getAIConsentDisclosure();

  return new Promise((resolve) => {
    let isSettled = false;
    const finish = (accepted: boolean) => {
      if (!isSettled) {
        isSettled = true;
        resolve(accepted);
      }
    };

    Alert.alert(
      disclosure.title,
      `${disclosure.recipient}\n\n${disclosure.data}\n\n${disclosure.purpose}\n\n${disclosure.retention}\n\n${disclosure.international}\n\n${disclosure.settings}`,
      [
        {
          text: 'Not Now',
          style: 'cancel',
          onPress: () => finish(false),
        },
        {
          text: 'Privacy Policy',
          onPress: () => {
            void Linking.openURL(AI_PRIVACY_POLICY_URL);
            finish(false);
          },
        },
        {
          text: 'Allow',
          onPress: () => {
            void acceptAIConsent(requestedSubject)
              .then(() => finish(activeConsentSubject === requestedSubject))
              .catch(() => finish(false));
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => finish(false),
      },
    );
  });
}
