# Briefing Claude 3 — Connecteur Leboncoin

> **Projet** : Hermès — système de dropshipping Temu → Leboncoin  
> **Ton rôle** : implémenter le connecteur Leboncoin (publication d'annonces + détection des ventes)  
> **Branche recommandée** : `worktree/claude3` depuis le commit `e842fc5`

---

## Contexte du projet

Hermès est un monorepo Node.js (`/home/user/hermes-project/`) avec :
- `apps/backend/` — API Express + SQLite (Claude 1, **terminé**)
- `apps/telegram/` — Bot Telegram Grammy (Claude 4, **terminé**)
- `apps/backend/src/services/temu-scraper.js` — scraper Temu (Claude 2, **terminé**)
- **`apps/backend/src/jobs/handlers.js`** — stubs que tu dois remplir (Claude 3, **à faire**)

---

## Ce qui t'attend : 2 stubs à implémenter

### Fichier : `apps/backend/src/jobs/handlers.js`

```js
// STUB 1 — à implémenter
async function handlePublishListing(payload, jobId) {
  // payload: { listingId }
  // Doit publier l'annonce sur Leboncoin et mettre à jour le statut en DB
  throw new Error("Not implemented — Claude 3");
}

// STUB 2 — à implémenter  
async function handleSyncTracking(payload, jobId) {
  // payload: { saleId }
  // Doit transmettre le suivi au compte Leboncoin si nécessaire
  throw new Error("Not implemented — Claude 3");
}
```

---

## API interne disponible (déjà codée, utilise-la)

### DB (`apps/backend/src/db/db.js`)
```js
const db = require("./db/db"); // singleton better-sqlite3
```

Tables utiles :
- `listings` — `listing_id, variant_id, account_id, price_eur_cents, status, scheduled_at`
- `seller_accounts` — `account_id, channel='leboncoin', credentials_ref, active`
- `listing_history` — log des changements de statut
- `sales` — `sale_id, listing_id, status, tracking_number, tracking_carrier`

### Service listings (`apps/backend/src/services/listings.js`)
```js
const { updateListingStatus } = require("./listings");
// updateListingStatus(listingId, newStatus, note) — log dans listing_history
```

### Service sales (`apps/backend/src/services/sales.js`)
```js
const { confirmDelivery } = require("./sales");
```

### Job queue (`apps/backend/src/jobs/queue.js`)
- Le job `handlePublishListing` est appelé avec `payload = { listingId }`
- Si tu lances un job secondaire depuis un handler, utilise `queue.enqueue(operation, payload, idempotencyKey)`

---

## Ce que doit faire `handlePublishListing`

1. Lire la listing en DB (avec ses variants/produit)
2. Lire le compte Leboncoin associé (`seller_accounts.credentials_ref`)
3. Appeler l'API Leboncoin (ou simuler en dev) pour publier l'annonce
4. Mettre à jour `listings.status` → `'active'` (ou `'failed'`)
5. Enregistrer l'`external_listing_id` retourné par Leboncoin (ajoute la colonne si besoin)

**Pour le dev/test :** si `NODE_ENV=test` ou `credentials_ref` commence par `mock_`, simule une publication réussie sans appel réseau réel.

---

## Ce que doit faire `handleSyncTracking`

1. Lire la vente + le numéro de suivi en DB
2. Si le compte Leboncoin supporte la transmission du suivi → appeler l'API
3. Marquer `sales.leboncoin_delivery_confirmed = 1` si Leboncoin confirme la livraison
4. Sinon, mettre `sales.manual_action_required = 1`

---

## Contrats à respecter (ne pas casser)

| Endpoint existant | Comportement attendu |
|---|---|
| `POST /api/listings` | crée en statut `draft`, enqueue `publish_listing` |
| `GET /api/listings/:id` | retourne `status` à jour |
| `GET /api/dashboard` | `activeSales`, `pendingJobs` reflètent l'état réel |
| `GET /admin/queue/jobs` | tes jobs apparaissent ici |

---

## Tests à faire passer

```bash
cd apps/backend
DB_PATH=:memory: NODE_ENV=test node --test src/__tests__/perceuse.test.mjs
DB_PATH=:memory: NODE_ENV=test node --test src/__tests__/integration.test.mjs
```

**Résultats attendus : 22/22 verts** (ils passent déjà — ne les casse pas).

Ajoute tes propres tests dans `apps/backend/src/__tests__/leboncoin.test.mjs`.

---

## Structure monorepo

```
hermes-project/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── db/          db.js, migrate.js, schema.sql
│   │   │   ├── services/    products.js, listings.js, sales.js, pricing.js, media.js
│   │   │   ├── jobs/        queue.js, handlers.js  ← TON FICHIER
│   │   │   ├── routes/      api.js, admin.js
│   │   │   └── index.js
│   │   └── package.json
│   └── telegram/            bot.js (Claude 4, ne pas modifier)
├── docs/obsidian/
│   ├── Contrats API.md      tous les endpoints documentés
│   └── claude3/             ← ton espace (ce fichier)
└── package.json             (npm workspaces)
```

---

## Règles de sécurité (obligatoires)

- **Jamais** de credentials réels dans le code ou les logs
- `credentials_ref` est un **pointeur** (ex: `"vault:lbc_compte_a"`) — ne stocke pas les vrais tokens en DB
- En test, utilise `mock_` prefix pour simuler sans appel réseau
- Pas d'adresse acheteur dans les logs (déjà géré par Claude 1)

---

## Pour démarrer

```bash
cd /home/user/hermes-project
git worktree add ../hermes-claude3 main
cd ../hermes-claude3
# ou sur ta propre machine :
git clone <repo> && cd hermes-dropshipping
npm install
DB_PATH=:memory: NODE_ENV=test node --test apps/backend/src/__tests__/perceuse.test.mjs
```

Bonne chance Claude 3 !
