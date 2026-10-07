import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSISTANT_IDENTITY_PROMPT,
  ASSISTANT_NAME,
  GHOSTWRITING_RULE,
  enforceAssistantIdentity,
  isAssistantIdentityQuestion,
} from './assistant-identity';

test('assistant is named Pinkie', () => {
  assert.equal(ASSISTANT_NAME, 'Pinkie');
  assert.match(ASSISTANT_IDENTITY_PROMPT, /Your name is Pinkie\./);
  assert.match(GHOSTWRITING_RULE, /never mention, sign as, or refer to Pinkie/);
});

test('detects questions about the assistant name or identity', () => {
  for (const question of [
    'What is your name?',
    "what's your name",
    'Whats ur name?',
    'Who are you?',
    'who r u',
    'Do you have a name?',
    'What should I call you?',
    'Who am I talking to?',
    'Are you ChatGPT?',
    'Is this Siri?',
  ]) {
    assert.equal(isAssistantIdentityQuestion(question), true, question);
  }
});

test('does not treat ordinary shopping questions as identity questions', () => {
  for (const question of [
    'Who are the top sellers?',
    'What is the name of this product?',
    'Track my order',
    'Can I change the name on my account?',
    'Who are you selling to?',
  ]) {
    assert.equal(isAssistantIdentityQuestion(question), false, question);
  }
});

test('rewrites replies that claim another identity', () => {
  assert.equal(
    enforceAssistantIdentity("Hi! I'm ChatGPT, how can I help?"),
    "Hi! I'm Pinkie, how can I help?",
  );
  assert.equal(
    enforceAssistantIdentity('I am an AI language model created to help.'),
    'I am Pinkie created to help.',
  );
  assert.equal(
    enforceAssistantIdentity('My name is Max and I can help.'),
    'My name is Pinkie and I can help.',
  );
  assert.equal(
    enforceAssistantIdentity("I don't have a name, but I can help."),
    'My name is Pinkie, but I can help.',
  );
});

test('rewrites replies that introduce the assistant under another personal name', () => {
  assert.equal(enforceAssistantIdentity("I'm Alex, how can I help?"), "I'm Pinkie, how can I help?");
  assert.equal(enforceAssistantIdentity('Hello! I am Alex.'), 'Hello! I am Pinkie.');
  assert.equal(enforceAssistantIdentity('Hi, I’m Sam and I can help.'), 'Hi, I’m Pinkie and I can help.');
  assert.equal(enforceAssistantIdentity('You can call me Max.'), 'You can call me Pinkie.');
  assert.equal(enforceAssistantIdentity("My name's Sam!"), "My name's Pinkie!");
  assert.equal(enforceAssistantIdentity('My name is alex.'), 'My name is Pinkie.');
  assert.equal(enforceAssistantIdentity('you can call me max.'), 'you can call me Pinkie.');
  assert.equal(
    enforceAssistantIdentity("Gettitonline's assistant here. I'm Alex, and the sellers' prices are great."),
    "Gettitonline's assistant here. I'm Pinkie, and the sellers' prices are great.",
  );
  assert.equal(
    enforceAssistantIdentity('The seller said "hello". I\'m Alex, your assistant.'),
    'The seller said "hello". I\'m Pinkie, your assistant.',
  );
});

test('leaves quoted text from other people untouched', () => {
  for (const reply of [
    'The seller said "My name is Alex and I ship fast."',
    'The seller wrote: “I’m Alex, call me Alex anytime.”',
    'Here is the message:\n> My name is Alex, I am ChatGPT.',
    "The seller wrote: 'My name is Alex.'",
    "The buyer said 'I'm Alex, call me Alex.' yesterday.",
    'The seller wrote: ‘My name is alex.’',
  ]) {
    assert.equal(enforceAssistantIdentity(reply), reply);
  }
});

test('leaves replies that already use Pinkie or mention no identity untouched', () => {
  for (const reply of [
    "I'm Pinkie, Gettitonline's shopping assistant.",
    'There are 42 products listed right now.',
    'The seller said the phone is in good condition.',
    "I'm Sorry, that item is out of stock.",
    'I am happy to help. Please call me back later.',
    'Order shipped. I am Unable to see private order details.',
  ]) {
    assert.equal(enforceAssistantIdentity(reply), reply);
  }
});
