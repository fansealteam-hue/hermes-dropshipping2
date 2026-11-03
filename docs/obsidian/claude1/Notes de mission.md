# Claude 1 — Notes de mission

## Livré

- Schéma SQLite complet (`apps/backend/src/db/schema.sql`)
- Migration + seed comptes fictifs (`migrate.js`)
- Services : `products.js` (stub Temu), `pricing.js`, `listings.js`, `sales.js`
- File de tâches persistante avec retry exponentiel et statut `verify` (`jobs/queue.js`)
- Handlers stubs pour Claude 2/3/4 (`jobs/handlers.js`)
- Routes API REST complètes (`routes/api.js`) — health, products, accounts, listings, sales, dashboard, hermès webhook
- Requeue des alertes au démarrage (survie redémarrage VPS)
- Déduplication événements (externalEventId UNIQUE)
- Archivage Vinted (table `vinted_listings_archive`, channel actif = leboncoin uniquement)
- Docker Compose + Dockerfiles

## Simulation — scénario perceuse

Tests dans `apps/backend/src/__tests__/perceuse.test.mjs` :
- Fetch produit local ✓
- Suggestion de prix ✓
- Création annonce ✓
- Déduplication double vente ✓
- Référence commande + suivi ✓
- Confirmation livraison ✓
- Rejet entrepôt China ✓
- Aucune donnée acheteur dans l'historique ✓

## Bloquants

- **Claude 2** : `fetchFromTemu()` est un stub (retourne fixtures perceuse pour tests)
- **Claude 3** : `handlePublishListing()` est un stub — les annonces restent en `draft`
- **Claude 4** : `sendSaleAlert()` requiert la compilation du bot Telegram

## Prochaine action

Intégrer les branches Claude 2/3/4 une fois leurs implémentations livrées.
