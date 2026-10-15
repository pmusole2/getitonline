// Copy of packages/shared/src/ai/assistantIdentity.ts. Convex does not import packages/shared, so this file must
// stay identical in behaviour. convex/lib/assistantIdentity.test.ts compares the two on a fixed corpus of inputs, so it
// catches divergence on those inputs only. Change both files together.
/** Name of the Gettitonline AI assistant. Every user-facing AI prompt should identify as this name. */
export const ASSISTANT_NAME = "Pinkie";

/** Identity rules included in every prompt where the assistant speaks as itself. */
export const ASSISTANT_IDENTITY_PROMPT = `Your name is ${ASSISTANT_NAME}. You are Gettitonline's AI assistant.
Always refer to yourself as ${ASSISTANT_NAME}. Never claim to be ChatGPT, GPT, OpenAI, or any other assistant, and never say you have no name.`;

/** Included in prompts that draft text a person will send under their own name. */
export const GHOSTWRITING_RULE = `The text you draft will be sent by a person, not by you. Write it in their voice and never mention, sign as, or refer to ${ASSISTANT_NAME} in the drafted text.`;

/** Deterministic answer to "what is your name?" so it never depends on the model. */
export const ASSISTANT_INTRODUCTION = `I'm ${ASSISTANT_NAME}, Gettitonline's shopping assistant! I can help you discover products, compare prices, track orders, and understand escrow and disputes. How can I help you today?`;

const OTHER_ASSISTANTS = String.raw`(?:chat\s?gpt|gpt(?:-[\w.]+)?|openai|claude|gemini|bard|copilot|siri|alexa|cortana)`;

const IDENTITY_QUESTION_PATTERNS: RegExp[] = [
  /\bwhat(?:'s|s| is)\s+(?:your|ur)\s+name\b/,
  /\b(?:do|have)\s+(?:you|u)\s+(?:have|got)\s+a\s+name\b/,
  /^\s*who\s+(?:are|r)\s+(?:you|u)\s*[?!.]*\s*$/,
  /\bwhat\s+(?:should|do|can|shall)\s+i\s+call\s+(?:you|u)\b/,
  /\bwho\s+am\s+i\s+(?:talking|speaking|chatting)\s+(?:to|with)\b/,
  new RegExp(String.raw`\b(?:are\s+(?:you|u)|is\s+this)\s+(?:an?\s+)?${OTHER_ASSISTANTS}\b`),
];

export function isAssistantIdentityQuestion(message: string): boolean {
  const normalized = message.toLowerCase().replace(/[’`]/g, "'");
  return IDENTITY_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

const OTHER_IDENTITY_CLAIM = new RegExp(
  String.raw`\b(I am|I['’]m|my name is|my name['’]s|call me)\s+(?:an?\s+)?(?:${OTHER_ASSISTANTS}|(?:large\s+)?(?:AI\s+)?language\s+model)\b`,
  "gi"
);

// Capitalized words that follow "I'm"/"I am" without being a personal name.
const NOT_NAMES = [
  "Sorry",
  "Happy",
  "Glad",
  "Here",
  "Not",
  "Unable",
  "Able",
  "Sure",
  "Afraid",
  "Excited",
  "Pleased",
  "Currently",
  "Just",
  "Also",
  "Still",
  "Always",
  "Really",
  "Very",
  "So",
  "Only",
  "Now",
  "Going",
  "Looking",
  "Checking",
  "Gettitonline",
].join("|");
const PERSONAL_NAME = String.raw`(?!(?:${ASSISTANT_NAME}|${NOT_NAMES})\b)[A-Z][a-z]+(?:-[A-Z][a-z]+)?(?=[\s,.!?;:)]|$)`;
// "I'm <Name>" only counts as an introduction at the start of a sentence or after a greeting.
const INTRODUCTION_START = String.raw`(^\s*|[.!?]\s+|\n\s*|\b(?:[Hh]i|[Hh]ello|[Hh]ey)(?:\s+there)?[,!.]?\s+)`;
const OTHER_NAME_INTRODUCTION = new RegExp(String.raw`${INTRODUCTION_START}(I am|I['’]m)\s+${PERSONAL_NAME}`, "g");
// After "my name is" any word is a name claim, whatever its case.
const MY_NAME_CLAIM = new RegExp(
  String.raw`\b(my name is|my name['’]s)\s+(?!not\b)[a-z]+(?:-[a-z]+)?(?=[\s,.!?;:)]|$)`,
  "gi"
);
// Lowercase words that follow "call me" without being a name ("call me back", "call me at 9").
const CALL_ME_NOT_NAMES = [
  "back",
  "later",
  "at",
  "on",
  "if",
  "when",
  "whenever",
  "anytime",
  "again",
  "now",
  "today",
  "tonight",
  "tomorrow",
  "before",
  "after",
  "to",
  "for",
  "with",
  "and",
  "or",
  "so",
  "please",
  "directly",
  "first",
  "soon",
  "once",
  "via",
  "by",
  "in",
  "any",
  "a",
  "an",
  "the",
  "anything",
  "that",
  "this",
].join("|");
const CALL_ME_CLAIM = new RegExp(
  String.raw`\b(call me)\s+(?!(?:${CALL_ME_NOT_NAMES})\b)[a-z]+(?:-[a-z]+)?(?=[\s,.!?;:)]|$)`,
  "gi"
);
const NO_NAME_CLAIM = /\bI\s+(?:do not|don['’]t)\s+have\s+a\s+(?:personal\s+)?name\b/gi;

// Quoted speech and blockquote lines belong to other people (e.g. a seller's message) and are never rewritten.
// A single quote only opens a quote when it isn't preceded by a letter, so apostrophes ("I'm", "sellers'")
// never start one, and apostrophes between letters inside a quote don't end it.
const QUOTED_SEGMENT = new RegExp(
  `(${[
    String.raw`"[^"\n]*"`,
    String.raw`“[^”\n]*”`,
    String.raw`(?<![\p{L}\p{N}])'(?=\S)(?:[^'\n]|(?<=\p{L})'(?=\p{L}))*?'(?![\p{L}\p{N}])`,
    String.raw`‘(?:[^’\n]|(?<=\p{L})’(?=\p{L}))*?’(?![\p{L}\p{N}])`,
    String.raw`^>.*$`,
  ].join("|")})`,
  "mu"
);

function correctSelfIdentification(text: string): string {
  return text
    .replace(OTHER_IDENTITY_CLAIM, `$1 ${ASSISTANT_NAME}`)
    .replace(OTHER_NAME_INTRODUCTION, `$1$2 ${ASSISTANT_NAME}`)
    .replace(MY_NAME_CLAIM, `$1 ${ASSISTANT_NAME}`)
    .replace(CALL_ME_CLAIM, `$1 ${ASSISTANT_NAME}`)
    .replace(NO_NAME_CLAIM, `My name is ${ASSISTANT_NAME}`);
}

/** Corrects model replies that self-identify as anything other than the assistant. */
export function enforceAssistantIdentity(reply: string): string {
  // split() with a capture group puts quoted segments at odd indexes.
  return reply
    .split(QUOTED_SEGMENT)
    .map((segment, index) => (index % 2 === 1 ? segment : correctSelfIdentification(segment)))
    .join("");
}
