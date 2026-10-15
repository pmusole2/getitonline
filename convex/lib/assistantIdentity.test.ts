import assert from 'node:assert/strict';
import test from 'node:test';

import * as local from './assistantIdentity';
import * as shared from '../../packages/shared/src/ai/assistantIdentity';

// Convex cannot import packages/shared, so convex/lib/assistantIdentity.ts is a hand-kept copy. These tests compare the
// two modules on a fixed corpus of inputs. They catch divergence on the inputs listed here, not on every possible input,
// so a change to one file must still be made to both.

const QUESTIONS = [
  // Identity questions, including case, whitespace, punctuation, curly apostrophes, and embedded phrasing.
  'What is your name?',
  "what's your name",
  'whats ur name',
  'WHAT IS YOUR NAME',
  '  what is your name?  ',
  'What’s your name?',
  'Hey, what is your name?',
  'Tell the seller: what is your name?',
  'Do you have a name?',
  'do u have a name',
  'Do you have a name for this listing?',
  'What should I call you?',
  'what do i call u',
  'Who are you?',
  'who r u',
  '  Who are you?  ',
  'who are u?!',
  'Who am I talking to?',
  'who am i speaking with',
  'Are you ChatGPT?',
  'are you an openai bot',
  'Is this Siri?',
  'Is this a gemini?',
  // Ordinary questions, including ones that share words with identity questions.
  'Who are the top sellers?',
  'Who are you selling to?',
  'Who are you and what do you sell?',
  'Who are you? Please answer.',
  'Quoted: "who are you?"',
  'What is the name of this product?',
  'Can I change the name on my account?',
  'I wonder what your name is.',
  'What do I call my dog?',
  'What should I do next?',
  'Do you have a refund policy?',
  'Are you selling this item?',
  'Is this iPhone any good?',
  'Who am I buying from?',
  'Who is talking?',
  'Where is my order?',
  'Track my order',
  '',
  '   ',
];

const REPLIES = [
  // Direct claims of another assistant identity.
  "Hi! I'm ChatGPT, how can I help?",
  'I’m ChatGPT, nice to meet you.',
  "I'm gpt-3.5-turbo, ask me anything.",
  'I am GPT-4o, here to help.',
  'I am an AI language model created to help.',
  'I am a large language model.',
  "I'm an AI language model.",
  'I am Claude, made by Anthropic.',
  'My name is Gemini.',
  'My name’s Copilot.',
  'You can call me Copilot.',
  'I am OpenAI’s assistant.',
  // Personal names, including greetings, case variants, hyphens, and sentence starts.
  'My name is Max and I can help.',
  "My name's Sam!",
  'My name is alex.',
  'MY NAME IS ALEX.',
  "I'm Alex, how can I help?",
  "Hi there, I'm Alex.",
  'Hey! I am Sam.',
  'Hello.  I’m Jordan.',
  "Good morning. I'm Taylor.",
  "Line one.\nI'm Alex.",
  "I'm Max-Lee, ok.",
  'You can call me Max.',
  'you can call me max.',
  'Please call me Ana.',
  // Phrases that look like a name claim but are not, or name no identity at all.
  "I'm Alex's assistant.",
  "I'm Pinkie, and I'm Alex.",
  "I'm Pinkie, Gettitonline's shopping assistant.",
  "I'm Happy to help.",
  "I'm Sorry, that item is out of stock.",
  'call me back later.',
  'Please call me tomorrow.',
  "I don't have a name, but I can help.",
  'I don’t have a personal name either.',
  'I do not have a name.',
  'My name is not important.',
  // Quoted speech and blockquotes belong to other people and must not be rewritten.
  'The seller said "My name is Alex and I ship fast."',
  'The seller wrote: “I’m Alex, call me Alex anytime.”',
  "The buyer said 'I'm Alex, call me Alex.' yesterday.",
  'Here is the message:\n> My name is Alex, I am ChatGPT.',
  'The seller wrote: "call me Max".',
  // Ordinary replies with nothing to correct.
  'There are 42 products listed right now.',
  'The seller said the phone is in good condition.',
  "Our sellers' ratings are high.",
  'I am happy to help. Please check your order.',
  'Order shipped. I am Unable to see private order details.',
  "Use `I'm Alex` in code.",
  // Mixed replies, and empty or whitespace-only input.
  "Multiple: I'm ChatGPT. I'm Alex. My name is Max.",
  "I'm ChatGPT. Call me Max tomorrow.",
  '',
  '   ',
  '\n\n',
];

test('the Convex copy exports the same constants as the shared module', () => {
  assert.equal(local.ASSISTANT_NAME, shared.ASSISTANT_NAME);
  assert.equal(local.ASSISTANT_IDENTITY_PROMPT, shared.ASSISTANT_IDENTITY_PROMPT);
  assert.equal(local.GHOSTWRITING_RULE, shared.GHOSTWRITING_RULE);
  assert.equal(local.ASSISTANT_INTRODUCTION, shared.ASSISTANT_INTRODUCTION);
});

test('the Convex copy classifies every corpus question exactly as the shared module does', () => {
  for (const question of QUESTIONS) {
    assert.equal(
      local.isAssistantIdentityQuestion(question),
      shared.isAssistantIdentityQuestion(question),
      JSON.stringify(question),
    );
  }
});

test('the Convex copy corrects every corpus reply exactly as the shared module does', () => {
  for (const reply of REPLIES) {
    assert.equal(local.enforceAssistantIdentity(reply), shared.enforceAssistantIdentity(reply), JSON.stringify(reply));
  }
});

test('the corpus has both matching and non-matching questions, and both corrected and untouched replies', () => {
  const identityQuestions = QUESTIONS.filter((question) => shared.isAssistantIdentityQuestion(question)).length;
  assert.ok(identityQuestions >= 10 && QUESTIONS.length - identityQuestions >= 10, 'questions cover both outcomes');

  const correctedReplies = REPLIES.filter((reply) => shared.enforceAssistantIdentity(reply) !== reply).length;
  assert.ok(correctedReplies >= 15 && REPLIES.length - correctedReplies >= 15, 'replies cover both outcomes');
});
