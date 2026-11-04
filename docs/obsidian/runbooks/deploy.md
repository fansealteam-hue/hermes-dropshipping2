# Runbook — Déploiement VPS

## Prérequis

- Node.js 20+
- Git
- Répertoire `data/` avec permissions d'écriture

## Premier déploiement

```bash
git clone https://github.com/fansealteam-hue/hermes-dropshipping2.git
cd hermes-dropshipping2

# Variables d'environnement
cp .env.example .env
# → Éditer .env avec les vraies valeurs (JAMAIS committé)

# Dépendances
cd apps/backend && npm ci
cd ../telegram && npm ci

# Base de données
cd apps/backend
npm run migrate

# Démarrage
npm start &
cd ../telegram && npm start &
```

## Mise à jour

```bash
git pull origin main
cd apps/backend && npm ci && npm run migrate && npm restart
cd ../telegram && npm ci && npm restart
```

## Variables d'environnement (.env)

```env
# Backend
NODE_ENV=production
PORT=3000
DB_PATH=./data/hermes.db

# Bot Telegram
TELEGRAM_BOT_TOKEN=<depuis @BotFather>
TELEGRAM_CHAT_ID=<ID du chat opérateur>
API_BASE_URL=http://localhost:3000

# Extension Chrome
EXTENSION_API_TOKEN=<token aléatoire fort>

# Optionnel
TEMU_SHIPPING_FEE=2.99
JOB_INTERVAL_MS=30000
```

## Données sensibles — NE JAMAIS COMMITTER

- `.env`
- `data/` (DB, sessions, photos)
- `data/sessions/` (sessions Grammy)
- Logs contenant des données acheteur

Ces répertoires sont dans `.gitignore`.

## Vérifications post-déploiement

```bash
curl http://localhost:3000/health
# → {"ok":true}

# Test migration
cd apps/backend && node src/db/migrate.js
# → Toutes les migrations "skip" (déjà appliquées)
```
