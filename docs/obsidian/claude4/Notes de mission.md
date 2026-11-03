# Claude 4 — Notes de mission

## Livré

### Bot Telegram (`apps/telegram/src/`)
- `config.ts` — auth guard (liste blanche de chat IDs)
- `api.ts` — client vers le backend
- `messages.ts` — formatters MarkdownV2 (escMd, fmtProduct, fmtSaleAlert, fmtTrackingAdded, fmtDashboard)
- `bot.ts` — commandes : /start, /lien, /dashboard, /commande, /suivi, /aide
  - Flux complet : lien Temu → variante → prix → compte → programmation
  - Inline keyboards à chaque étape
  - `sendSaleAlert()` exporté pour le job queue (Claude 1)

### Site privé (`apps/web/`)
- `server.js` — proxy Express avec token auth, SPA fallback
- `public/index.html` — interface mobile-first thème sombre :
  - Tableau de bord (stats, actions requises, activité)
  - Nouvelle annonce (stepper 5 étapes)
  - Liste des ventes
  - Formulaire de suivi

### Mini App Telegram (`apps/mini-app/`)
- `index.html` — interface Telegram WebApp SDK
  - Mêmes 4 onglets que le site
  - Thème adapté aux variables CSS Telegram
  - Appels API avec initData pour l'auth

## Tests

```bash
node --test apps/telegram/src/__tests__/messages.test.mjs
# Tests : escMd, fmtSaleAlert, fmtTrackingAdded
```

## Bloquants

- Bot Telegram : nécessite `TELEGRAM_BOT_TOKEN` en prod
- Compilation TypeScript : `npm install && npx tsc` dans `apps/telegram/`
- Mini App : doit être servi en HTTPS (exigence Telegram) via le site web ou un nginx

## Prochaine action

1. Compiler le bot : `cd apps/telegram && npm install && npx tsc`
2. Configurer le webhook ou long-polling selon l'installation Hermès
3. Tester l'alerte de vente en conditions réelles avec un compte de test
