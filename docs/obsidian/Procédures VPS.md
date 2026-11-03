---
responsable: Claude 1
---

# Procédures VPS

## Démarrage initial

```bash
# 1. Cloner le dépôt
git clone <URL_DEPOT> /opt/hermes
cd /opt/hermes

# 2. Configurer les secrets (NE PAS committer)
cp .env.example .env
nano .env  # renseigner TELEGRAM_BOT_TOKEN, API_SECRET_TOKEN, etc.

# 3. Lancer
docker compose up -d

# 4. Vérifier la santé
curl http://localhost:3001/health
curl http://localhost:3000/api/health
```

## Redémarrage

```bash
docker compose restart backend
# Le backend requeue automatiquement les alertes non envoyées au démarrage
```

## Mise à jour

```bash
git pull origin main
docker compose up -d --build
```

## Rollback

```bash
git log --oneline -10          # trouver le commit précédent
git checkout <commit_hash>
docker compose up -d --build
```

## Sauvegarde de la base

```bash
# Copie à chaud (WAL mode — safe en production)
sqlite3 /data/hermes/hermes.db ".backup /backup/hermes-$(date +%Y%m%d-%H%M).db"

# Restauration sur instance isolée
sqlite3 /tmp/hermes-test.db ".restore /backup/hermes-20241103-1000.db"
```

## Worktrees pour les autres sessions

```bash
# Créer les worktrees à partir de main
git worktree add ../hermes-claude2 -b feat/claude2-temu
git worktree add ../hermes-claude3 -b feat/claude3-lbc
git worktree add ../hermes-claude4 -b feat/claude4-ui

# Chaque session ouvre son dossier :
# Claude 2 : /opt/hermes-claude2
# Claude 3 : /opt/hermes-claude3
# Claude 4 : /opt/hermes-claude4
```

## Points de contrôle santé

```bash
# Backend
curl http://localhost:3001/health
# → {"ok":true,"timestamp":"…"}

# Jobs en attente de vérification
sqlite3 /data/hermes/hermes.db "SELECT job_id, operation, last_error FROM jobs WHERE status='verify';"

# Alertes non envoyées
sqlite3 /data/hermes/hermes.db "SELECT sale_id FROM sales WHERE alert_sent=0;"
```
