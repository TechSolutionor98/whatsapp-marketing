import { db, isMongoUp, audit } from './db/mongo.js';
import { emit } from './events.js';

// WhatsApp refused a message we sent (Baileys handleBadAck → status ERROR with the server's
// error code), e.g. posting in an admins-only group. It was never delivered, so show it as
// "not sent" instead of leaving it at a single tick.
export async function markFailed(waId, errorCode) {
  if (!waId || !isMongoUp()) return;
  try {
    const r = await db.messages().updateOne(
      { wa_message_id: waId, direction: 'out', $or: [{ status_code: { $exists: false } }, { status_code: { $lt: 3 } }] },
      { $set: { status: 'failed', error_code: errorCode ? String(errorCode) : '' } }
    );
    if (r.modifiedCount) {
      audit('reply', `WhatsApp rejected a sent message${errorCode ? ` (error ${errorCode})` : ''} — marked as not sent`, { level: 'warn' });
      emit('message:status', { waId });
    }
  } catch {
    /* ignore */
  }
}

// WhatsApp message status numbers: 2=server ack (sent), 3=delivered, 4=read, 5=played.
function codeFrom(status) {
  if (typeof status === 'number') {
    if (status >= 4) return 4;
    if (status === 3) return 3;
    if (status === 2) return 2;
    return null;
  }
  return { SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 4 }[status] || null;
}

// Upgrade (never downgrade) an outbound message's delivery status by its WhatsApp id.
export async function applyReceipt(waId, status) {
  if (!waId || !isMongoUp()) return;
  const code = codeFrom(status);
  if (!code) return;
  try {
    const r = await db.messages().updateOne({ wa_message_id: waId, direction: 'out' }, [
      { $set: { status_code: { $max: [{ $ifNull: ['$status_code', 2] }, code] } } },
      {
        $set: {
          status: {
            $switch: {
              branches: [
                { case: { $gte: ['$status_code', 4] }, then: 'read' },
                { case: { $eq: ['$status_code', 3] }, then: 'delivered' },
              ],
              default: 'sent',
            },
          },
        },
      },
    ]);
    if (r.modifiedCount) emit('message:status', { waId });
  } catch {
    /* ignore */
  }
}

// Attach a messages.update listener to any Baileys socket (main or pool).
export function attachReceipts(sock) {
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates || []) {
      if (!u?.key?.fromMe) continue;
      const st = u.update?.status;
      if (st === undefined || st === null) continue;
      if (st === 0 || st === 'ERROR') {
        markFailed(u.key.id, u.update?.messageStubParameters?.[0]); // codeFrom() ignored these before
        continue;
      }
      applyReceipt(u.key.id, st);
    }
  });
}
