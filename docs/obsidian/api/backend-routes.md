# Référence API Backend

Base URL : `http://localhost:3000`

## Produits

| Méthode | Chemin | Description |
|---------|--------|-------------|
| POST | `/api/products/fetch` | Récupère produit Temu par URL |
| POST | `/api/products/import-from-extension` | Import depuis extension Chrome (token requis) |

## Annonces

| Méthode | Chemin | Description |
|---------|--------|-------------|
| POST | `/api/listings` | Crée annonce (status: draft) |
| GET | `/api/listings/:id` | Récupère annonce |
| GET | `/api/listings` | Liste annonces (filtrable par status, accountId) |
| POST | `/api/listings/bump-all` | Remonte toutes les annonces actives |

## Comptes vendeur

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/accounts/leboncoin` | Liste comptes LBC actifs |
| POST | `/api/accounts/sync-all` | Enfile jobs sync pour tous les comptes |

## Ventes

| Méthode | Chemin | Description |
|---------|--------|-------------|
| POST | `/api/sales/confirm` | Confirme une vente (webhook LBC) |
| GET | `/api/sales` | Liste ventes actives |
| GET | `/api/sales/:id` | Récupère vente |
| POST | `/api/sales/:id/confirm-order` | Enregistre commande fournisseur → order_placed |
| POST | `/api/sales/:id/cancel` | Annule vente |
| POST | `/api/sales/:id/confirm-available` | Confirme disponibilité |
| POST | `/api/sales/:id/republish` | Republication annonce |
| POST | `/api/sales/:id/close` | Ferme vente |
| PATCH | `/api/sales/:id/tracking` | Ajoute numéro de suivi |
| POST | `/api/sales/:id/sync-tracking` | Lance sync suivi transporteur |

## Messages

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/messages/unread` | Messages acheteurs non répondus |
| POST | `/api/messages/reply` | Réponse automatique à un message |
| POST | `/api/negotiate` | Réponse à une offre de prix |

## Callbacks / Déduplication

| Méthode | Chemin | Description |
|---------|--------|-------------|
| POST | `/api/callbacks/mark-done` | Marque callback Telegram comme traité |

## Dashboard & Agents

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/dashboard` | KPIs + résumé |
| GET | `/api/agents/status` | Statut des agents Claude |

## Formats de réponse

Toutes les routes retournent `{ ok: boolean, data?, error?, ... }`.

Codes HTTP :
- `200` : succès
- `400` : payload invalide
- `401` : token manquant/invalide
- `404` : ressource introuvable
- `409` : conflit (duplicate event)
- `500` : erreur interne
