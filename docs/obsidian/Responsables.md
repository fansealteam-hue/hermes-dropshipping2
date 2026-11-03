---
responsable: Claude 1
---

# Responsables

## Fichiers par session

### Claude 1 — Backend & intégration
- `apps/backend/` — tout le répertoire
- `packages/shared/src/types.ts` — contrats TypeScript
- `docker-compose.yml`, `Dockerfile`s
- `docs/obsidian/Architecture.md`, `Contrats API.md`, `Responsables.md`

### Claude 2 — Catalogue Temu & médias
- `apps/backend/src/services/products.js` — remplacer `fetchFromTemu()`
- `apps/backend/src/services/pricing.js` — ajuster `suggestPrice()`
- `docs/obsidian/claude2/`

### Claude 3 — Connecteur Leboncoin
- `apps/backend/src/jobs/handlers.js` — `handlePublishListing()`, `handleSyncTracking()`
- Route `POST /api/sales/confirm` — appelée depuis le webhook Leboncoin
- `docs/obsidian/claude3/`

### Claude 4 — Site & Telegram
- `apps/web/` — site privé
- `apps/telegram/` — bot + tests
- `apps/mini-app/` — Mini App Telegram
- `docs/obsidian/claude4/`

## Notes partagées — responsable unique

| Note | Responsable |
|------|-------------|
| Architecture.md | Claude 1 |
| Contrats API.md | Claude 1 |
| Responsables.md | Claude 1 |
| Décisions.md | Claude 1 |
| Registre des skills.md | Claude 1 |
| Procédures VPS.md | Claude 1 |
| claude2/*.md | Claude 2 |
| claude3/*.md | Claude 3 |
| claude4/*.md | Claude 4 |
