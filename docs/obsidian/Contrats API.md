---
responsable: Claude 1
---

# Contrats API — Échanges entre sessions

Tous les échanges passent par `POST|GET /api/*` sur `http://localhost:3001`.  
Auth : header `x-api-key: <API_SECRET_TOKEN>` (optionnel en dev).

---

## 1. Importer une source Temu (Claude 2 → Backend)

**Claude 2** implémente `fetchFromTemu(url)` dans `apps/backend/src/services/products.js`.

```js
// Input
{ temuUrl: "https://www.temu.com/perceuse-sans-fil-18v.html" }

// Output OK
{ ok: true, data: {
  temuItemId: "TEMU-DRILL-001",
  title: "Perceuse sans fil 18V",
  warehouseStatus: "local",  // "local" | "china" | "unknown"
  variants: [
    { variantId: "VAR-DRILL-SOLO", label: "Perceuse seule", costEur: 15.00, stock: 42, imageUrls: ["…"] },
    { variantId: "VAR-DRILL-PACK", label: "Pack avec batterie", costEur: 22.00, stock: 18, imageUrls: ["…","…","…"] }
  ],
  fetchedAt: "2024-11-03T10:00:00Z"
}}

// Output BLOQUÉ (entrepôt China)
{ ok: true, data: { …, warehouseStatus: "china" } }
// → createListing() lève { code: "INELIGIBLE_WAREHOUSE" }
```

---

## 2. Retourner une variante prête ou bloquée

```js
// Prête
{ variantId: "VAR-DRILL-PACK", label: "Pack avec batterie", costEur: 22.00, stock: 18 }

// Bloquée (stock 0)
{ variantId: "VAR-DRILL-PACK", stock: 0 }
// → afficher avertissement, ne pas créer l'annonce
```

---

## 3. Calculer un prix (Claude 2 → services/pricing.js)

```js
import { suggestPrice, validatePrice } from "../services/pricing.js";

suggestPrice(22.00)  // → 66.99
validatePrice(22.00, 25.00)  // → { valid: false, reason: "Marge insuffisante (minimum 5 €)" }
validatePrice(22.00, 66.99)  // → { valid: true }
```

---

## 4. Demander une publication (Claude 3 ← Backend job)

Le backend enqueue automatiquement un job `publish_listing`.  
**Claude 3** implémente le handler dans `apps/backend/src/jobs/handlers.js`.

```js
// Job payload
{ listingId: "lst_abc123" }

// Claude 3 doit appeler :
const { updateListingStatus } = require("../services/listings");
updateListingStatus("lst_abc123", "published", {
  leboncoinAdId: "lbc_ad_456789",
  publishedAt: new Date().toISOString()
});

// En cas d'erreur : lever une exception → queue gère le retry
throw new Error("LBC_API_ERROR: rate limit");
```

---

## 5. Recevoir le résultat d'une publication

```js
// Listing publié (en DB)
{ listingId: "lst_abc123", status: "published", leboncoinAdId: "lbc_456789", publishedAt: "…" }

// Listing en erreur (après 3 tentatives)
{ listingId: "lst_abc123", status: "failed" }
// → job.status = "failed", last_error = "LBC_API_ERROR: rate limit"
// → opérateur voit l'annonce dans le tableau de bord avec statut "failed"
```

---

## 6. Confirmer une vente (Claude 3 → Backend)

```js
// Claude 3 appelle POST /api/sales/confirm
{
  listingId: "lst_abc123",
  externalEventId: "lbc_event_789",  // OBLIGATOIRE pour déduplication
  salePriceEur: 65.99,
  buyerName: "Jean D.",              // optionnel
  deliveryCity: "Paris"              // ville seulement, pas d'adresse complète
}

// Réponse — première confirmation
{ ok: true, data: { saleId: "sale_xyz", status: "confirmed", … }, duplicate: false }

// Réponse — doublon (même externalEventId)
{ ok: true, data: { saleId: "sale_xyz", … }, duplicate: true }
// → ne pas traiter deux fois, ne pas envoyer deux alertes
```

---

## 7. Enregistrer un achat fournisseur

```js
// PATCH /api/sales/:id/tracking
{ orderRef: "ORD-DRILL-2024", trackingNumber: "", trackingCarrier: "" }

// Réponse
{ ok: true, data: { saleId: "…", orderRef: "ORD-DRILL-2024", status: "order_placed" } }
```

---

## 8. Transmettre un suivi

```js
// PATCH /api/sales/:id/tracking
{ orderRef: "", trackingNumber: "CP1234567890FR", trackingCarrier: "Colis Privé" }

// Réponse
{ ok: true, data: { trackingNumber: "CP1234567890FR", status: "tracking_added" } }
// → job sync_tracking enqueué automatiquement
```

---

## Comportements en cas de doublon

| Situation | Comportement |
|-----------|-------------|
| POST /api/sales/confirm avec même externalEventId | Retourne la vente existante + `duplicate: true` |
| Job `publish_listing` créé deux fois pour même listing | `idempotency_key = "publish:<listingId>"` — INSERT OR IGNORE |
| Job `send_alert` créé deux fois | `idempotency_key = "alert:<saleId>"` — INSERT OR IGNORE |
| Tracking ajouté deux fois | Écrase (PATCH — idempotent) |

## Comportement après coupure

Si le backend redémarre entre l'envoi d'une publication LBC et la réception de la réponse :
1. Job passe en status `verify` après 1 tentative échouée
2. Claude 3 doit vérifier l'état distant avant de re-publier
3. Opérateur voit les jobs `verify` dans le tableau de bord
4. Aucune republication aveugle
