import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { messageSide, viewerSide } from './conversationSides';

// Labels who is speaking in a dispute conversation. A message carries the side recorded when it was written, so a
// later role change never relabels it. The viewer's side follows the viewer's current access, which the server limits
// to company disputes for catalog staff.

const dispute = { buyerId: 'users|buyer', sellerId: 'users|company' };

describe('viewerSide', () => {
  it('the buyer speaks as the buyer', () => {
    assert.equal(viewerSide({ _id: 'users|buyer', role: 'user' }, dispute), 'buyer');
  });

  it('the company seller account speaks as the seller', () => {
    assert.equal(viewerSide({ _id: 'users|company', role: 'user' }, dispute), 'seller');
  });

  it('a catalog manager replying for the company speaks as the seller', () => {
    assert.equal(viewerSide({ _id: 'users|catalog', role: 'catalog_manager' }, dispute), 'seller');
  });

  it('other viewers keep the existing buyer fallback', () => {
    assert.equal(viewerSide({ _id: 'users|moderator', role: 'moderator' }, dispute), 'buyer');
  });
});

describe('messageSide', () => {
  it('labels buyer and seller messages by account when no side was recorded', () => {
    assert.equal(messageSide({ senderId: 'users|buyer' }, dispute), 'buyer');
    assert.equal(messageSide({ senderId: 'users|company' }, dispute), 'seller');
  });

  it('a recorded side is used as written', () => {
    assert.equal(messageSide({ senderId: 'users|catalog', speakerSide: 'seller' }, dispute), 'seller');
    assert.equal(messageSide({ senderId: 'users|moderator', speakerSide: 'moderator' }, dispute), 'moderator');
  });

  it('a reviewer note stays a moderator note after that account becomes catalog staff', () => {
    const note = {
      senderId: 'users|moderator',
      speakerSide: 'moderator' as const,
      sender: { role: 'catalog_manager' },
    };
    assert.equal(messageSide(note, dispute), 'moderator');
  });

  it('a message without a recorded side is labelled by sender account, ignoring a catalog role', () => {
    const legacy = { senderId: 'users|moderator', sender: { role: 'catalog_manager' } };
    assert.equal(messageSide(legacy, dispute), 'moderator');
  });

  it('a delegate reply keeps its seller side after that account loses catalog staff status', () => {
    const reply = { senderId: 'users|catalog', speakerSide: 'seller' as const, sender: { role: 'user' } };
    assert.equal(messageSide(reply, dispute), 'seller');
  });
});
