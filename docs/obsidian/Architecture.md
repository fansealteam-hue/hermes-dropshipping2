---
responsable: Claude 1
---

# Architecture Hermès

## Vue d'ensemble

```
Telegram Bot ──┐
Telegram Mini ──┤──▶ Web App (port 3000) ──▶ Backend API (port 3001) ──▶ SQLite DB
Site privé ───┘                                       │
                                                      ├─▶ Job Queue ──▶ Leboncoin (Claude 3)
                                                      │                ──▶ Temu scraper (Claude 2)
                                                      └─▶ Hermès runner (events entrants)
```

## Services

| Service | Port | Fichier principal | Responsable |
|---------|------|-------------------|-------------|
| Backend API | 3001 | `apps/backend/src/index.js` | Claude 1 |
| Site web | 3000 | `apps/web/src/server.js` | Claude 4 |
| Bot Telegram | — | `apps/telegram/src/bot.ts` | Claude 4 |
| Mini App | — | `apps/mini-app/src/index.html` | Claude 4 |

## Base de données

SQLite (`better-sqlite3`) — chemin configurable via `DB_PATH`.  
Schéma : `apps/backend/src/db/schema.sql`  
Migration : `node apps/backend/src/db/migrate.js`

Tables principales :
- `products` + `variants` — Claude 2
- `listings` + `listing_history` — Claude 1/3
- `sales` + `sale_history` — Claude 1
- `jobs` — file de tâches persistante
- `seller_accounts` — comptes Leboncoin
- `events` — événements Hermès (dedup)
- `bot_sessions` — état de conversation Telegram
- `vinted_listings_archive` — données Vinted archivées (inactif)

## Flux principal : nouvelle annonce

1. Utilisateur envoie lien Temu → bot/site → `POST /api/products/fetch`
2. Backend vérifie entrepôt local (seul critère d'éligibilité)
3. Utilisateur choisit variante → calcul prix (Claude 2 `suggestPrice`)
4. `POST /api/listings` → listing `draft` en DB + job `publish_listing`
5. Job queue → Claude 3 publie sur Leboncoin → `updateListingStatus('published')`

## Flux : vente confirmée

1. Leboncoin webhook → Claude 3 → `POST /api/sales/confirm` (avec `externalEventId`)
2. Backend dédup, insère en `sales`, enqueue job `send_alert`
3. Bot Telegram envoie alerte privée (y compris après redémarrage)
4. Utilisateur effectue achat fournisseur → `/commande` ou site
5. Utilisateur transmet suivi → `/suivi` ou site
6. Job `sync_tracking` → Claude 3 notifie Leboncoin
7. Leboncoin confirme réception → `confirmDelivery()`
