/**
 * Historique des conversations acheteurs (Leboncoin).
 *
 * Chaque appel à POST /api/messages/reply enregistre le message de l'acheteur
 * et la réponse générée (ou l'escalade vers le vendeur). Le dashboard lit
 * ensuite les fils via GET /api/conversations.
 */
const db = require("../db/db");
const { randomUUID } = require("crypto");

let ready = false;
function init() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      message_id       TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      account_id       TEXT,
      listing_id       TEXT,
      buyer_name       TEXT,
      direction        TEXT NOT NULL,          -- in (acheteur) | out (réponse)
      body             TEXT NOT NULL,
      action           TEXT,                   -- send | escalate | suspend (réponses)
      decision         TEXT,                   -- accept | counter | reject (offres)
      offer_eur_cents  INTEGER,
      created_at       TEXT NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at)");
  ready = true;
}

function convIdFor({ conversationId, listingId, buyerName }) {
  if (conversationId) return String(conversationId);
  return `conv_${listingId}_${(buyerName ?? "acheteur").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function logExchange({ conversationId, accountId, listingId, buyerName, buyerMessage, result }) {
  init();
  const conv = convIdFor({ conversationId, listingId, buyerName });
  const now = new Date();
  const ins = db.prepare(`INSERT INTO messages (message_id, conversation_id, account_id, listing_id, buyer_name, direction, body, action, decision, offer_eur_cents, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const id = () => `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  ins.run(id(), conv, accountId ?? null, listingId ?? null, buyerName ?? null, "in", buyerMessage, null, null,
    result?.offerEur != null ? Math.round(result.offerEur * 100) : null, now.toISOString());
  if (result?.reply) {
    ins.run(id(), conv, accountId ?? null, listingId ?? null, buyerName ?? null, "out", result.reply, result.action ?? "send",
      result.decision ?? null, null, new Date(now.getTime() + 1).toISOString());
  }
  return conv;
}

function rowToMessage(r) {
  return {
    messageId: r.message_id,
    direction: r.direction,
    body: r.body,
    action: r.action ?? undefined,
    decision: r.decision ?? undefined,
    offerEur: r.offer_eur_cents != null ? r.offer_eur_cents / 100 : undefined,
    createdAt: r.created_at,
  };
}

function listConversations({ limit = 100 } = {}) {
  init();
  const rows = db.prepare(`
    SELECT m.conversation_id,
           MAX(m.created_at) AS last_at,
           COUNT(*) AS n,
           SUM(CASE WHEN m.direction = 'in' THEN 1 ELSE 0 END) AS n_in,
           SUM(CASE WHEN m.direction = 'out' AND m.action = 'send' THEN 1 ELSE 0 END) AS n_auto,
           SUM(CASE WHEN m.offer_eur_cents IS NOT NULL THEN 1 ELSE 0 END) AS n_offers,
           MAX(m.account_id) AS account_id, MAX(m.listing_id) AS listing_id, MAX(m.buyer_name) AS buyer_name
    FROM messages m
    GROUP BY m.conversation_id
    ORDER BY last_at DESC
    LIMIT ?
  `).all(parseInt(limit) || 100);
  const last = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1");
  const lastOut = db.prepare("SELECT action FROM messages WHERE conversation_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT 1");
  const lastIn = db.prepare("SELECT created_at FROM messages WHERE conversation_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1");
  const listing = db.prepare("SELECT l.title, l.price_eur_cents, l.status, l.leboncoin_ad_id FROM listings l WHERE l.listing_id = ?");
  return rows.map((r) => {
    const l = last.get(r.conversation_id);
    const out = lastOut.get(r.conversation_id);
    const li = r.listing_id ? listing.get(r.listing_id) : null;
    // À toi de répondre : dernier message de l'acheteur sans réponse, ou réponse escaladée/suspendue
    const needsYou = l.direction === "in" || (out && out.action !== "send");
    return {
      conversationId: r.conversation_id,
      accountId: r.account_id ?? undefined,
      listingId: r.listing_id ?? undefined,
      listingTitle: li?.title,
      listingPriceEur: li ? li.price_eur_cents / 100 : undefined,
      listingStatus: li?.status,
      leboncoinAdId: li?.leboncoin_ad_id ?? undefined,
      buyerName: r.buyer_name ?? undefined,
      messageCount: r.n,
      buyerMessages: r.n_in,
      autoReplies: r.n_auto,
      offers: r.n_offers,
      needsYou,
      lastMessage: rowToMessage(l),
      lastBuyerAt: lastIn.get(r.conversation_id)?.created_at,
      lastAt: r.last_at,
    };
  });
}

function getConversation(conversationId) {
  init();
  const msgs = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC").all(conversationId);
  if (!msgs.length) return null;
  return { conversationId, messages: msgs.map(rowToMessage) };
}

module.exports = { logExchange, listConversations, getConversation };
