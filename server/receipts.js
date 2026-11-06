import { db, isMongoUp } from './db/mongo.js';
import { emit } from './events.js';

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
      applyReceipt(u.key.id, st);
    }
  });
}
