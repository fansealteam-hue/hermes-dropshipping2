# Compte-rendu Claude B — Hermès Dropshipping

## Ce que j'ai implémenté

### 1. Répondeur automatique acheteurs (`apps/backend/src/services/auto-responder.js`)
- Détecte les mots litige → escalade opérateur
- Extrait les offres de prix → moteur de négociation
- Répond "non disponible" si annonce vendue
- En production : appel Claude API (`claude-haiku-5-5`)
- En test : règles statiques (pas d'appel réseau)

### 2. Moteur de négociation (`apps/backend/src/services/negotiation.js`)
- ≥ 95% du prix → accepte
- 85–95% → contre-propose à 95%
- 70–85% → contre-propose au prix affiché
- < 70% → refuse poliment
- Seuils configurables via env : `NEGO_ACCEPT_PCT`, `NEGO_COUNTER_PCT`, `NEGO_REFUSE_PCT`

### 3. Flow Telegram vente complet (`apps/telegram/src/bot.js`)

Alerte vente → photo produit + boutons :
- **✅ OUI disponible** → affiche infos acheteur + lien Temu + bouton VALIDER → puis bouton "Ajouter suivi"
- **❌ NON plus dispo** → job LBC : message auto à l'acheteur + retrait annonce (pas de mauvais avis)

Suivi inline :
- Bouton "📦 Ajouter le numéro de suivi" → saisie `<transporteur> <numéro>` → transmis auto sur LBC

### 4. Jobs handlers (`apps/backend/src/jobs/handlers.js`)
- `publish_listing` : Playwright → publie annonce LBC (mock en test)
- `sync_tracking` : Playwright → envoie tracking dans conversation LBC
- `mark_listing_sold` : Playwright → clôture annonce LBC
- `cancel_sale_lbc` : Playwright → message annulation acheteur + retrait annonce
- `send_alert` : envoie alerte Telegram avec photo + composition variante

### 5. Routes API ajoutées (`apps/backend/src/routes/api.js`)
- `GET /api/finance?period=7d|30d|90d` : dashboard financier complet
- `POST /api/messages/reply` : auto-reply acheteur
- `POST /api/negotiate` : évaluer une offre
- `POST /api/sales/:id/sync-tracking` : déclencher transmission suivi
- `POST /api/sales/:id/cancel` : annuler vente + job LBC
- `POST /api/sales/:id/confirm-available` : confirmer disponibilité

### 6. Dashboard financier (`apps/web/public/index.html`)
- 5 KPI cards : ventes, revenu, marge, coût, jobs en erreur
- Graphique barres : revenu + marge par jour
- Top produits, ventes actives
- Auto-refresh 30s, thème dark, responsive mobile

### 7. Infrastructure VPS
- `apps/backend/Dockerfile` : node:22-slim + chromium via apt
- `docker-compose.yml` : security_opt seccomp:unconfined pour Playwright
- `setup-vps.sh` : script setup Ubuntu/Debian one-shot
- `DEMARRAGE_RAPIDE.md` : guide déploiement 5 min

---

## Ce que Claude A doit savoir

### Mock mode
`NODE_ENV=test` **ou** `credentials_ref` commence par `"mock_"` → aucun appel réseau, aucun Playwright.

### Sécurité
- `credentials_ref` = pointeur uniquement (ex: `vault:lbc_compte_a`) — jamais le vrai token en DB
- Adresse acheteur jamais dans les logs
- `ANTHROPIC_API_KEY` et `TELEGRAM_BOT_TOKEN` uniquement via env

### Chromium sur VPS
```
CHROMIUM_PATH=/usr/bin/chromium   # Docker
CHROMIUM_PATH=/opt/pw-browsers/chromium  # local dev
```
Playwright se lance seulement à la demande (pas en permanence) → ~300 MB RAM pendant un job, puis libéré.

### Variables d'env clés ajoutées
```
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-haiku-5-5
NEGO_ACCEPT_PCT=0.95
NEGO_COUNTER_PCT=0.85
NEGO_REFUSE_PCT=0.70
CHROMIUM_PATH=/usr/bin/chromium
```

### Tests
```bash
NODE_ENV=test DB_PATH=:memory: node --test apps/backend/src/__tests__/*.test.mjs
NODE_ENV=test node --test apps/telegram/src/__tests__/*.test.mjs
# Résultat : 39 backend + 6 telegram = 45 tests, 0 échec
```

### Sélecteurs Playwright LBC
Les sélecteurs `data-testid` (ex: `message-input`, `send-message`, `mark-as-sold`) sont des **estimations** — à valider sur un vrai compte LBC avant mise en production. Ils peuvent changer après une mise à jour LBC.

---

## Branche / commit final
- Branche : `main`
- Dernier commit : `87ae38b` — *feat: flow vente OUI/NON avec annulation LBC automatique*
