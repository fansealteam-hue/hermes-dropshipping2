# Stack Technique

## Services

| Service | Technologie | Port | Rôle |
|---------|------------|------|------|
| Backend | Node.js + Express | 3000 | API REST + job runner |
| Telegram Bot | Grammy v1 (Node.js) | — | Interface opérateur |
| DB | SQLite WAL (better-sqlite3) | — | Données persistantes |
| Extension | Chrome MV3 | — | Import Temu/LBC/Vinted |
| Dashboard | HTML/CSS/JS vanilla | /dashboard | Interface web |

## Dépendances clés

- `grammy ^1.26` — bot Telegram
- `@grammyjs/storage-file ^2.0` — sessions persistantes sur disque
- `better-sqlite3 ^9.4` — SQLite synchrone
- `sharp ^0.35` — traitement images
- `node-cron ^3.0` — scheduler nocturne
- `express ^4.18` — API REST

## Variables d'environnement requises

```env
# Bot Telegram
TELEGRAM_BOT_TOKEN=       # jamais committé
TELEGRAM_CHAT_ID=         # ID du chat opérateur

# Backend
API_BASE_URL=http://localhost:3000
DB_PATH=./data/hermes.db

# Extension Chrome
EXTENSION_API_TOKEN=      # token partagé bot↔extension

# Optionnel
TEMU_SHIPPING_FEE=2.99
NODE_ENV=production
```

Voir `.env.example` pour la liste complète.

## Répertoires de données (hors git)

```
data/
  hermes.db         ← base SQLite
  sessions/         ← sessions Grammy (FileAdapter)
  photos/           ← images produits (3 par produit)
    <temuItemId>/
      01.jpg
      02.jpg
      03.jpg
```
