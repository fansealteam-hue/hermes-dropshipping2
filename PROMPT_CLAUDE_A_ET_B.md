# PROMPT — Hermès Dropshipping Automatisé
## Repo : https://github.com/fansealteam-hue/hermes-dropshipping2

---

## CONTEXTE DU PROJET

Système dropshipping Temu → Leboncoin entièrement automatisé.
Backend Node.js + SQLite + Bot Telegram Grammy déjà en place.
22 tests passent. Le repo est partagé entre deux sessions Claude (A et B).

---

## CLAUDE A — Scrapin, Photos, Prix, Descriptions

### Ta mission

**1. Temu Scraper amélioré** (`apps/backend/src/services/temu-scraper.js`)
- Récupérer : titre, variantes, prix fournisseur, images HD, dimensions, poids, caractéristiques (batterie, taille, couleur, matière)
- Détecter entrepôt local obligatoirement
- Stocker toutes les specs dans la table `variants` (ajoute les colonnes manquantes si besoin)

**2. Régénération des photos** (`apps/backend/src/services/photo-enhancer.js`) — NOUVEAU FICHIER
- Télécharger les images Temu en HD
- Recadrer proprement (fond blanc ou neutre)
- Supprimer les watermarks Temu
- Renommer en `[itemId]_[variantId]_[n].jpg`
- Utiliser sharp (npm) pour le traitement
- Stocker dans `data/media/`

**3. Moteur de prix** (`apps/backend/src/services/pricing.js`)
- Multiplicateurs configurables via `.env` :
  - `PRICE_MULTIPLIER_DEFAULT=3` (x3 standard)
  - `PRICE_MULTIPLIER_FAST=4` (x4 livraison rapide)
  - `PRICE_MULTIPLIER_PREMIUM=10` (x10 niche premium)
- Logique : `Math.floor(cost * multiplier) - 0.01` (ex: 22€ × 3 = 65,99€)
- Ajouter automatiquement `+3€` si mode livraison "autre" sélectionné
- `suggestPriceStrategy(costEur, category)` → retourne les 3 options

**4. Générateur de descriptions IA** (`apps/backend/src/services/description-generator.js`) — NOUVEAU FICHIER
- À partir des specs scrapées, générer :
  - **Titre Leboncoin** (max 70 chars) : `[Produit] [spec principale] [état] — [ville]`
  - **Description optimisée** (400-600 chars) :
    - Accroche (1 ligne)
    - Specs clés : taille, batterie, poids, couleur, contenu du pack
    - État : Neuf sous emballage
    - Livraison : Colissimo suivi / Mondial Relay
    - Prix ferme ou petite négociation acceptée
  - Format Markdown compatible Leboncoin
- Utiliser l'API Claude (`@anthropic-ai/sdk`) avec le prompt suivant :
```
Tu es un expert en vente sur Leboncoin. Génère un titre (max 70 chars) et une description 
vendeuse (400-600 chars) pour ce produit. Inclus les specs techniques clés. 
Ton style : direct, honnête, professionnel. Jamais de fautes. 
Produit : {specs}
```

### Tests à créer
`apps/backend/src/__tests__/photo-enhancer.test.mjs`
`apps/backend/src/__tests__/description-generator.test.mjs`

### Ne pas casser
22 tests existants : `DB_PATH=:memory: NODE_ENV=test node --test apps/backend/src/__tests__/*.test.mjs`

---

## CLAUDE B — IA Réponses Auto, Négociation, Flow Telegram

### Ta mission

**1. Répondeur automatique Leboncoin** (`apps/backend/src/services/auto-responder.js`) — NOUVEAU FICHIER
- Répondre automatiquement aux questions des acheteurs via webhook Leboncoin
- Utiliser Claude API pour générer les réponses :
```
Tu es un vendeur sympa sur Leboncoin. Réponds à cette question sur le produit.
Sois bref (2-3 lignes max), professionnel, donne les infos exactes du produit.
Si prix demandé → appliquer la logique de négociation.
Produit : {specs} | Question : {question}
```
- Endpoint : `POST /api/hermes/message` reçoit `{ listingId, question, buyerName }`
- Logguer dans table `events` (déjà existante)

**2. Moteur de négociation automatique** (`apps/backend/src/services/negotiation.js`) — NOUVEAU FICHIER
- Règles configurables dans `.env` :
  - `NEGO_MIN_PERCENT=85` (accepter si ≥ 85% du prix affiché)
  - `NEGO_COUNTER_PERCENT=95` (contre-proposer à 95%)
- Logique :
  - Offre ≥ 85% → accepter automatiquement → déclencher flow vente
  - Offre 70-85% → contre-proposer à 95% avec message sympa
  - Offre < 70% → refus poli, maintenir prix
- Réponse automatique générée par Claude API

**3. Flow Telegram amélioré** (`apps/telegram/src/bot.js` — modifier)

Quand une vente est confirmée, envoyer sur Telegram :

```
🛍️ NOUVELLE VENTE — ACTION REQUISE

Produit : Perceuse sans fil 18V — Pack avec batterie
Prix vendu : 65,99 € (livraison incluse)
Mode livraison : Autre (+3€ inclus)
Acheteur : Marie M. — Lyon

📦 Commander sur Temu :
https://temu.com/perceuse-18v-...
Variante : Pack avec batterie (ref: VAR-DRILL-PACK)
Prix fournisseur : 22,00 €
Bénéfice net estimé : ~40,99 €

[✅ COMMANDER] [❌ ANNULER]
```

- Bouton `✅ COMMANDER` → envoie les infos acheteur (nom + ville + mode livraison)
- Bouton `❌ ANNULER` → marque la vente comme annulée, message auto à l'acheteur

**4. Transmission du numéro de suivi** (déjà dans bot.js, améliorer)

Commande `/suivi [saleId] [transporteur] [numéro]` doit :
1. Enregistrer en DB
2. Envoyer automatiquement à l'acheteur Leboncoin via API
3. Mettre à jour le statut Leboncoin en "expédié"
4. Confirmer sur Telegram :
```
✅ Suivi transmis à l'acheteur
📬 CP1234567890FR — Colissimo
👤 Marie M. a été notifiée automatiquement
```

**5. Endpoint infos acheteur** (`apps/backend/src/routes/api.js` — ajouter)
- `GET /api/sales/:id/buyer-info` → retourne nom + ville + mode livraison (PAS email/téléphone complet)
- Protégé par token

### Tests à créer
`apps/backend/src/__tests__/negotiation.test.mjs`
`apps/backend/src/__tests__/auto-responder.test.mjs`

### Ne pas casser
22 tests existants : `DB_PATH=:memory: NODE_ENV=test node --test apps/backend/src/__tests__/*.test.mjs`

---

## RÈGLES COMMUNES (les deux Claude)

1. **Toujours travailler sur une branche** :
   ```bash
   git checkout -b feature/claude-a   # ou claude-b
   git push -u origin feature/claude-a
   ```

2. **Merger via PR** — ne jamais pusher directement sur `main`

3. **Variables d'environnement** — ajouter dans `.env.example`, jamais de valeurs réelles en clair

4. **Clé API Claude** — utiliser `ANTHROPIC_API_KEY` depuis `.env`, ne jamais la logger

5. **Sécurité** — l'endpoint buyer-info ne retourne jamais email, téléphone, adresse complète

6. **Tests** — chaque nouveau service a son fichier de test, les 22 existants doivent rester verts

---

## STACK TECHNIQUE

- Node.js 22, Express 4, better-sqlite3, Grammy 1.x
- `@anthropic-ai/sdk` pour les appels Claude API
- `sharp` pour le traitement d'images
- Playwright pré-installé à `/opt/pw-browsers/chromium`
- Docker Compose pour le déploiement

## POUR DÉMARRER

```bash
git clone https://github.com/fansealteam-hue/hermes-dropshipping2
cd hermes-dropshipping2
npm install
DB_PATH=:memory: NODE_ENV=test node --test apps/backend/src/__tests__/*.test.mjs
# → 22/22 verts = tu peux commencer
```
