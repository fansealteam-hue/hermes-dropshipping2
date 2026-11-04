# Corrections Phase B — TYNO V5

## Bug 1 — confirm_payment sans écriture DB

**Symptôme** : Callback `confirm_payment` affichait "commande validée" sans rien écrire en base.

**Correction** : Ajout état `awaiting_order_details` → opérateur saisit `<ref> [prix]` → `POST /sales/:id/confirm-order` → `status: order_placed`.

## Bug 2 — avail_no faux succès immédiat

**Symptôme** : Annulation envoyait "annulation effectuée" avant d'appeler l'API.

**Correction** : Flux 2 étapes — prompt de confirmation → `cancel_confirm:saleId` → appel API → résultat réel (succès ou erreur avec bouton retry).

## Bug 3 — Prix minimum x3

**Symptôme** : `Math.floor(variant.costEur * 3) + 0.99` — multiplicateur 3, sans frais de vente, arrondi incorrect.

**Correction** :
```js
const rawMin = (totalCosts * MULTIPLICATEUR + FRAIS_LIVRAISON) / (1 - FRAIS_VENTE_PCT);
const suggested = Math.ceil(rawMin * 20) / 20; // arrondi 0.05€ supérieur
// MULTIPLICATEUR = 4, FRAIS_VENTE_PCT = 0.08, FRAIS_LIVRAISON = 3.00
```

## Bug 4 — api.js sans timeout ni vérification HTTP

**Symptôme** : Requêtes pouvaient rester pendantes indéfiniment ; erreur HTTP 500 retournée comme succès.

**Correction** : `AbortController` timeout 15s, vérification `r.ok`, parsing JSON conditionnel, validation `content-type`.

## Bug 5 — Sessions perdues au redémarrage

**Symptôme** : `session({ initial })` stockait en mémoire.

**Correction** : `FileAdapter({ dirName: SESSION_DIR })` depuis `@grammyjs/storage-file`.

## Bug 6 — Annonce publiée directement

**Symptôme** : `createListing({ status: 'active' })` — annonce marquée publiée sans confirmation plateforme.

**Correction** : `status: 'draft'` à la création. Worker `publish_listing` passe à `active` après confirmation.

## Bug 7 — saleId non validé côté serveur

**Symptôme** : Actions sur `saleId` inexistant passaient silencieusement.

**Correction** : `api.getSale(saleId)` avant toute action, retour 404 si absent.

## Bug 8 — Callbacks non idempotents

**Symptôme** : Double-tap sur un bouton Telegram déclenchait deux fois l'action.

**Correction** : `POST /api/callbacks/mark-done` + table `callback_log`, `guardCallback()` retourne tôt si `alreadyDone`.

## Bug 9 — Dates en UTC au lieu de Europe/Paris

**Symptôme** : "demain 09h" calculé en UTC, soit 11h en été / 10h en hiver côté opérateur Paris.

**Correction** : `fmtParis(d)` via `Intl.DateTimeFormat({ timeZone:'Europe/Paris' })`, `tomorrowParisAt9()` convertit correctement.

## Bug 10 — Secrets dans les fichiers (confirmé absent)

Aucun secret, cookie, token ou credential dans les fichiers commités. Validation effectuée.
