// Who is speaking in a dispute conversation. A message carries the side recorded when it was written, so a later role
// change never relabels it. Only a message written before that record existed falls back to its sender account.
export type ConversationSide = 'buyer' | 'seller' | 'moderator';

interface DisputeParties {
  buyerId: string;
  sellerId: string;
}

interface Viewer {
  _id: string;
  role: string;
}

interface Speaker {
  senderId: string;
  speakerSide?: ConversationSide;
}

// The side the signed-in viewer replies for. The server shows catalog staff only company disputes, so for them the
// seller side is the company's side. A viewer who is neither party keeps the buyer label, as before.
export function viewerSide(viewer: Viewer, dispute: DisputeParties): 'buyer' | 'seller' {
  if (viewer._id === dispute.buyerId) {
    return 'buyer';
  }
  if (viewer._id === dispute.sellerId || viewer.role === 'catalog_manager') {
    return 'seller';
  }
  return 'buyer';
}

export function messageSide(message: Speaker, dispute: DisputeParties): ConversationSide {
  if (message.speakerSide) {
    return message.speakerSide;
  }
  // Written before speaker sides were recorded: the sender account decides, and a role never does.
  if (message.senderId === dispute.buyerId) {
    return 'buyer';
  }
  if (message.senderId === dispute.sellerId) {
    return 'seller';
  }
  return 'moderator';
}
