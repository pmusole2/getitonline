export const AI_CONSENT_VERSION = 2;
export const AI_RECIPIENT = 'OpenAI, LLC via the Gettitonline backend';

export type AIConsentSubject = 'guest' | `account:${string}`;

export interface AIConsentRecord {
  version: typeof AI_CONSENT_VERSION;
  acceptedAt: string;
  recipient: typeof AI_RECIPIENT;
  subject: AIConsentSubject;
}

export function createAIConsentRecord(
  subject: AIConsentSubject,
  acceptedAt = new Date(),
): AIConsentRecord {
  return {
    version: AI_CONSENT_VERSION,
    acceptedAt: acceptedAt.toISOString(),
    recipient: AI_RECIPIENT,
    subject,
  };
}

export function isAIConsentRecordForSubject(
  value: unknown,
  subject: AIConsentSubject,
): value is AIConsentRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<AIConsentRecord>;
  return (
    record.version === AI_CONSENT_VERSION &&
    typeof record.acceptedAt === 'string' &&
    !Number.isNaN(Date.parse(record.acceptedAt)) &&
    record.recipient === AI_RECIPIENT &&
    record.subject === subject
  );
}

export function getAIConsentDisclosure() {
  return {
    title: 'Allow data sharing for AI features?',
    recipient: `Recipient: ${AI_RECIPIENT}.`,
    data:
      'Depending on the feature, Gettitonline sends the prompts or images you choose, product or listing details, shopping activity and category interests, and order, dispute, or messages needed for your request.',
    purpose:
      'OpenAI processes this data to generate the shopping assistance, search result, recommendation, moderation result, or message help you request.',
    retention:
      'OpenAI API inputs and outputs are not used for model training by default and may be retained for abuse monitoring for up to 30 days.',
    international:
      'This processing may occur outside Zambia. Do not submit passwords, payment card numbers, or government identifiers.',
    settings:
      'You can decline and keep using non-AI features, or turn AI features off later in Settings.',
  };
}
