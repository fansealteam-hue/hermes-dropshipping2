# PROMPT CLAUDE B — Auto-répondeur & Négociation Leboncoin

## Contexte du projet

Tu travailles sur **Hermès**, un système de dropshipping automatisé **Temu → Leboncoin**.
Repo GitHub : `https://github.com/fansealteam-hue/hermes-dropshipping2`
Branche de base : `feature/claude-a` (toutes les features Claude A sont là, 39/39 tests verts)
Ta branche de travail : `feature/claude-b` (à créer depuis `feature/claude-a`)

## Architecture du projet

```
hermes-dropshipping2/
├── apps/
│   ├── backend/          ← Express.js + SQLite (port 3001)
│   │   └── src/
│   │       ├── db/           migrate.js, schema.sql, db.js
│   │       ├── routes/       products.js, accounts.js, listings.js, dashboard.js
│   │       ├── services/
│   │       │   ├── pricing.js           ← FAIT par Claude A (adaptatif)
│   │       │   ├── description-generator.js  ← FAIT par Claude A (Claude API)
│   │       │   ├── photo-enhancer.js    ← FAIT par Claude A (sharp)
│   │       │   └── temu-scraper.js      ← FAIT par Claude A (Playwright)
│   │       ├── jobs/
│   │       │   ├── queue.js             ← file de jobs persistante
│   │       │   └── handlers.js          ← handlers à compléter
│   │       └── __tests__/
│   │           ├── integration.test.mjs  ← 22 tests existants
│   │           └── claude-a.test.mjs     ← 17 tests Claude A
│   └── telegram/         ← Bot Grammy JS (port séparé)
│       └── src/
│           └── bot.js    ← bot Telegram à enrichir
├── docker-compose.yml
└── .env.example
```

## Ce que Claude A a déjà fait (NE PAS retoucher)

1. **Scraper Temu** — `temu-scraper.js` : Playwright + API fallback, extractSpecs()
2. **Photo enhancer** — `photo-enhancer.js` : sharp, crop watermarks, resize 1200px
3. **Pricing adaptatif** — `pricing.js` :
   - `<10€ → ×5`, `10-20€ → ×4`, `20-40€ → ×3`, `40-80€ → ×2.5`, `>80€ → ×2`
   - Frais livraison Temu intégrés (2.99€ par défaut, `TEMU_SHIPPING_FEE`)
   - `suggestPrice(costEur, { deliveryOther, temuShipping })`
   - `suggestPriceStrategy(costEur)` → `{ standard, fast, premium }`
4. **Générateur descriptions** — `description-generator.js` : Claude Haiku API, fallback sync

## Tes tâches (branche `feature/claude-b`)

### Tâche B1 — Auto-répondeur Leboncoin (handlers.js)

Fichier : `apps/backend/src/jobs/handlers.js`

Il y a un stub `handleAutoReply` à implémenter. Quand un acheteur envoie un message sur une annonce Leboncoin, le système doit répondre automatiquement avec un message naturel.

**Logique métier :**
- Si le message contient une question sur la disponibilité → "Bonjour, oui l'article est toujours disponible !"
- Si le message contient une offre de prix (ex: "je vous offre 50€") → voir Tâche B2
- Si le message contient une demande d'infos → répondre avec les specs du produit
- Sinon → message générique de bienvenue

**Contraintes :**
- Utiliser `claude-haiku-4-5` via `@anthropic-ai/sdk` (déjà dans package.json)
- Fallback sync si pas d'API key (comme description-generator.js)
- NE PAS envoyer de vrais messages Leboncoin — juste générer le texte (le connecteur LBC est une étape future)
- Exposer `generateAutoReply(message, product, listing)` → `{ replyText, intent }`

### Tâche B2 — Moteur de négociation

Fichier : `apps/backend/src/services/negotiation.js` (à créer)

Quand un acheteur propose un prix, le système doit décider automatiquement :
- **Accepter** si `offeredPrice >= listedPrice * 0.9` (moins de 10% de remise)
- **Contre-proposer** si `offeredPrice >= totalCost * 1.5` (encore rentable)
- **Refuser poliment** si l'offre est sous le seuil de rentabilité

**Interface :**
```js
function evaluateOffer(offeredPrice, listedPrice, totalCostEur)
// → { decision: 'accept' | 'counter' | 'refuse', counterPrice?, replyText }
```

Utiliser `totalCostEur` depuis `suggestPriceStrategy()` (déjà exposé dans pricing.js).

### Tâche B3 — Flow Telegram amélioré (bot.js)

Fichier : `apps/telegram/src/bot.js`

Ajouter ces commandes / handlers Grammy :

1. **`/price <lien_temu>`** → scrape le produit, affiche les 3 stratégies de prix en boutons inline
2. **`/reply <listing_id> <message>`** → génère une réponse auto pour un message acheteur
3. **Boutons inline** sur chaque annonce : `[✅ Accepter offre] [💬 Contre-proposer] [❌ Refuser]`
4. **Notification de vente** : quand une vente est confirmée via l'API, envoyer un résumé :
   ```
   🎉 Vente confirmée !
   Produit : [titre]
   Prix vendu : XX€ | Coût : XX€ | Bénéfice : +XX€
   ```

**Contraintes :**
- Grammy v1 (déjà installé), plain JavaScript, pas de TypeScript
- NE PAS hardcoder de token Telegram — lire `process.env.TELEGRAM_BOT_TOKEN`
- Le bot doit démarrer sans token (mode dégradé, log warning) pour les tests

### Tâche B4 — Tests

Fichier : `apps/backend/src/__tests__/claude-b.test.mjs`

Écrire les tests pour :
- `evaluateOffer` : accepte / contre-propose / refuse selon les seuils
- `generateAutoReply` : détecte l'intent (disponibilité / offre / infos / autre)
- Intégration : un message acheteur → intent détecté → réponse générée

**Format des tests** : identique à `claude-a.test.mjs` (node:test, assert/strict, createRequire)

## Règles de sécurité ABSOLUES

- ❌ Aucun vrai message Leboncoin envoyé en dev/test
- ❌ Aucun achat Temu déclenché
- ❌ Cookies, sessions, adresses clients → hors des commits et logs
- ✅ Tester avec données fictives uniquement
- ✅ Mode `NODE_ENV=test` bypass toutes les API externes

## Comment démarrer

```bash
git clone https://github.com/fansealteam-hue/hermes-dropshipping2
cd hermes-dropshipping2
git checkout feature/claude-a
git checkout -b feature/claude-b
npm install
cd apps/backend && npm test   # vérifier 39/39 verts avant de commencer
```

## Références utiles

- Pricing : `apps/backend/src/services/pricing.js` — lire les fonctions exportées
- Description generator : `apps/backend/src/services/description-generator.js` — copier le pattern (async + fallback sync)
- Tests existants : `apps/backend/src/__tests__/claude-a.test.mjs` — copier le format exactement
- Grammy docs : https://grammy.dev (v1)

## Livraison attendue

- Branche `feature/claude-b` poussée sur GitHub
- Tous les tests passent (39 existants + tes nouveaux)
- PR vers `feature/claude-a` ou `main`
- Aucun secret dans les commits
