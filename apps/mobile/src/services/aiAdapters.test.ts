import assert from 'node:assert/strict';
import test from 'node:test';

import { AiRequestError, type AiRequestCode } from '../../../../packages/shared/src/ai/aiRequests';
import {
  adaptChat,
  adaptDisputeAnalysis,
  adaptModerateListing,
  adaptRecommendations,
  adaptRephrase,
  adaptResolutionMessage,
  adaptSimilarProducts,
  adaptSuggestions,
  adaptVisualSearch,
  aiErrorMessage,
  AI_REFUSAL_COPY,
  disputeFailureMessage,
} from './aiAdapters';

test('chat maps each action to the legacy shape and keeps the reply as the message', () => {
  const response = adaptChat({
    ok: true,
    source: 'ai',
    reply: 'Here is a navigation shortcut.',
    actions: [
      { type: 'navigate', label: 'Go to Orders', payload: { screen: 'Orders' } },
      { type: 'search', label: 'Search phones', payload: { query: 'phone' } },
    ],
  });

  assert.deepEqual(response, {
    message: 'Here is a navigation shortcut.',
    source: 'ai',
    actions: [
      { type: 'navigate', label: 'Go to Orders', payload: { screen: 'Orders' } },
      { type: 'search', label: 'Search phones', payload: { query: 'phone' } },
    ],
  });
});

test('a chat fallback keeps its own source, so it is never presented as an ai reply', () => {
  const response = adaptChat({
    ok: true,
    source: 'fallback',
    reply: 'Pinkie cannot look that up right now.',
    actions: [],
  });

  assert.equal(response.source, 'fallback');
  assert.equal(response.message, 'Pinkie cannot look that up right now.');
});

test('recommendations keep product ids, reasoning, and the source', () => {
  assert.deepEqual(
    adaptRecommendations({
      ok: true,
      source: 'fallback',
      productIds: ['p1'],
      reasoning: 'Showing the newest listings.',
    }),
    { productIds: ['p1'], reasoning: 'Showing the newest listings.', source: 'fallback' },
  );
});

test('similar products keep the legacy plain list of ids', () => {
  assert.deepEqual(adaptSimilarProducts({ ok: true, source: 'ai', productIds: ['p2', 'p3'] }), ['p2', 'p3']);
});

test('visual search keeps the legacy query and terms, and an empty fallback stays empty', () => {
  assert.deepEqual(adaptVisualSearch({ ok: true, source: 'ai', query: 'red bike', terms: ['red', 'bike'] }), {
    query: 'red bike',
    terms: ['red', 'bike'],
    source: 'ai',
  });
  assert.deepEqual(adaptVisualSearch({ ok: true, source: 'fallback', query: '', terms: [] }), {
    query: '',
    terms: [],
    source: 'fallback',
  });
});

test('a saved moderation result carries its status, summary, flags, and saved flag', () => {
  assert.deepEqual(
    adaptModerateListing({
      ok: true,
      source: 'ai',
      saved: true,
      revision: 5,
      status: 'flagged',
      summary: 'Photos do not match the title.',
      flags: ['image_mismatch'],
    }),
    {
      status: 'flagged',
      summary: 'Photos do not match the title.',
      flags: ['image_mismatch'],
      saved: true,
      source: 'ai',
    },
  );
});

test('an unsaved moderation fallback is typed as an error that was not saved', () => {
  const response = adaptModerateListing({
    ok: true,
    source: 'fallback',
    saved: false,
    revision: 5,
    status: 'error',
    summary: 'AI moderation is unavailable because OpenAI is not configured.',
    flags: ['ai_unavailable'],
  });

  assert.equal(response.saved, false);
  assert.equal(response.status, 'error');
  assert.equal(response.source, 'fallback');
});

test('every refusal code has truthful copy, and none of it claims an AI success', () => {
  const codes: AiRequestCode[] = [
    'consent_required',
    'session_required',
    'account_required',
    'account_unavailable',
    'rate_limited',
    'invalid_request',
    'product_unavailable',
    'forbidden',
    'not_found',
    'stale',
    'invalid_output',
    'too_long',
    'unavailable',
    'account_changed',
  ];
  for (const code of codes) {
    const copy = AI_REFUSAL_COPY[code];
    assert.ok(copy.length > 0, `${code} has copy`);
    assert.doesNotMatch(copy, /\b(completed|complete|success|succeeded)\b/i, `${code} does not claim success`);
  }
  assert.match(AI_REFUSAL_COPY.consent_required, /allow/i);
  assert.match(AI_REFUSAL_COPY.rate_limited, /limit/i);
  assert.match(AI_REFUSAL_COPY.stale, /changed/i);
  assert.match(AI_REFUSAL_COPY.stale, /run AI moderation again/i);
  assert.match(AI_REFUSAL_COPY.forbidden, /reviewer/i);
  assert.equal(AI_REFUSAL_COPY.too_long, 'Your draft is too long to rephrase. Shorten it and try again.');
});

test('an error from a request is shown with its copy, and a discarded result shows nothing', () => {
  assert.equal(aiErrorMessage(new AiRequestError('rate_limited')), AI_REFUSAL_COPY.rate_limited);
  assert.equal(
    aiErrorMessage(new AiRequestError('account_changed')),
    null,
    'the old account result is discarded silently',
  );
});

test('an unexpected error shows the unavailable copy, never the raw message', () => {
  assert.equal(aiErrorMessage(new Error('Internal: secret listing text')), AI_REFUSAL_COPY.unavailable);
  assert.equal(aiErrorMessage('plain string'), AI_REFUSAL_COPY.unavailable);
});

test('a rewritten draft is offered as a suggestion, and the same text from the ai is not offered as a change', () => {
  assert.deepEqual(
    adaptRephrase({ ok: true, source: 'ai', rephrased: 'Please send the tracking number.' }, 'send tracking pls'),
    {
      kind: 'suggested',
      text: 'Please send the tracking number.',
    },
  );
  assert.deepEqual(adaptRephrase({ ok: true, source: 'ai', rephrased: 'Where is my order?' }, 'Where is my order?'), {
    kind: 'kept',
    message: 'No changes were suggested. Your message was left as written.',
  });
});

test('an unchanged draft is kept, and names quotation marks as the reason only when the draft has them', () => {
  const quoted = adaptRephrase(
    { ok: true, source: 'unchanged', rephrased: 'He said "no" to me' },
    'He said "no" to me',
  );
  assert.equal(quoted.kind, 'kept');
  assert.match(quoted.kind === 'kept' ? quoted.message : '', /quotation marks/);
  assert.match(quoted.kind === 'kept' ? quoted.message : '', /never changed/);

  const plain = adaptRephrase({ ok: true, source: 'unchanged', rephrased: 'Where is my order?' }, 'Where is my order?');
  assert.deepEqual(plain, { kind: 'kept', message: 'Your message was left as written.' });
});

test('suggested replies keep the order the backend returned them', () => {
  assert.deepEqual(
    adaptSuggestions({ ok: true, source: 'ai', suggestions: ['Thanks, I will check.', 'Can you send a photo?'] }),
    ['Thanks, I will check.', 'Can you send a photo?'],
  );
});

test("a participant's analysis keeps only the viewer's claims and sentiment, for the viewer's side", () => {
  const buyerView = adaptDisputeAnalysis({
    ok: true,
    source: 'ai',
    summary: 'The parcel was late.',
    keyPoints: {
      yourClaims: ['It never arrived'],
      theirClaims: ['It shipped on time'],
      buyerClaims: ['It never arrived'],
      sellerClaims: ['It shipped on time'],
    },
    sentiment: { yours: 'frustrated', theirs: 'cooperative', buyer: 'frustrated', seller: 'cooperative' },
    suggestedResolutions: [{ type: 'full_refund', description: 'Refund the order.', fairnessScore: 8 }],
    recommendedAction: 'Share the tracking number.',
    riskLevel: 'medium',
    additionalNotes: '',
    viewerRole: 'buyer',
  });
  assert.deepEqual(buyerView, {
    viewer: 'participant',
    side: 'buyer',
    summary: 'The parcel was late.',
    yourClaims: ['It never arrived'],
    theirClaims: ['It shipped on time'],
    yourSentiment: 'frustrated',
    theirSentiment: 'cooperative',
    suggestedResolutions: [{ type: 'full_refund', description: 'Refund the order.', fairnessScore: 8 }],
    recommendedAction: 'Share the tracking number.',
    riskLevel: 'medium',
    additionalNotes: '',
  });

  const sellerView = adaptDisputeAnalysis({
    ok: true,
    source: 'ai',
    summary: 'The parcel was late.',
    keyPoints: {
      yourClaims: ['It shipped on time'],
      theirClaims: ['It never arrived'],
      buyerClaims: ['It never arrived'],
      sellerClaims: ['It shipped on time'],
    },
    sentiment: { yours: 'cooperative', theirs: 'frustrated', buyer: 'frustrated', seller: 'cooperative' },
    suggestedResolutions: [],
    recommendedAction: '',
    riskLevel: 'low',
    additionalNotes: '',
    viewerRole: 'seller',
  });
  assert.equal(sellerView.viewer, 'participant');
  assert.equal(sellerView.viewer === 'participant' ? sellerView.side : '', 'seller');
  assert.deepEqual(sellerView.viewer === 'participant' ? sellerView.yourClaims : [], ['It shipped on time']);
  assert.equal(sellerView.viewer === 'participant' ? sellerView.yourSentiment : '', 'cooperative');
});

test("a reviewer's analysis puts the buyer's claims and sentiment in the buyer column, and the seller's in the seller column", () => {
  const view = adaptDisputeAnalysis({
    ok: true,
    source: 'ai',
    summary: 'The buyer reports a missing parcel and the seller reports a shipment.',
    keyPoints: {
      yourClaims: [],
      theirClaims: [],
      buyerClaims: ['The item never arrived'],
      sellerClaims: ['Shipped on 3 May with tracking'],
    },
    sentiment: { yours: 'frustrated', theirs: 'cooperative', buyer: 'frustrated', seller: 'cooperative' },
    suggestedResolutions: [],
    recommendedAction: 'Ask the carrier for a trace.',
    riskLevel: 'high',
    additionalNotes: '',
    viewerRole: 'moderator',
  });
  assert.deepEqual(view, {
    viewer: 'reviewer',
    summary: 'The buyer reports a missing parcel and the seller reports a shipment.',
    buyerClaims: ['The item never arrived'],
    sellerClaims: ['Shipped on 3 May with tracking'],
    buyerSentiment: 'frustrated',
    sellerSentiment: 'cooperative',
    suggestedResolutions: [],
    recommendedAction: 'Ask the carrier for a trace.',
    riskLevel: 'high',
    additionalNotes: '',
  });
});

test('a generated resolution message is shown as the text the reviewer may use', () => {
  assert.equal(
    adaptResolutionMessage({ ok: true, source: 'ai', message: 'We will refund the order.' }),
    'We will refund the order.',
  );
});

test('a dispute refusal reads as a dispute, never as a listing or a moderation, and other codes keep the shared copy', () => {
  assert.equal(
    disputeFailureMessage(new AiRequestError('not_found')),
    'This dispute could not be found. It may have been removed.',
  );
  const forbidden = disputeFailureMessage(new AiRequestError('forbidden'));
  assert.match(forbidden ?? '', /dispute/);
  assert.doesNotMatch(forbidden ?? '', /moderation|listing/i);
  assert.equal(disputeFailureMessage(new AiRequestError('too_long')), AI_REFUSAL_COPY.too_long);
  assert.equal(disputeFailureMessage(new AiRequestError('account_changed')), null);
  assert.equal(disputeFailureMessage(new Error('raw text')), AI_REFUSAL_COPY.unavailable);
});
