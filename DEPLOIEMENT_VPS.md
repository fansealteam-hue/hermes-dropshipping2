# Déploiement Hermès sur VPS

## Prérequis VPS
- Ubuntu 22.04+ (ou Debian 12)
- 2 Go RAM minimum, 20 Go disque
- Docker + Docker Compose v2 installés
- Un nom de domaine ou IP publique

---

## 1. Préparer le serveur

```bash
# Mettre à jour le système
sudo apt update && sudo apt upgrade -y

# Installer Docker (si pas déjà fait)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Installer Docker Compose v2
sudo apt install -y docker-compose-plugin
docker compose version   # doit afficher v2.x
```

---

## 2. Cloner le projet

```bash
git clone https://github.com/fansealteam-hue/hermes-dropshipping2.git hermes
cd hermes
```

---

## 3. Configurer l'environnement

```bash
cp .env.example .env
nano .env
```

**Variables obligatoires** à remplir dans `.env` :

```env
# Token API (générer un secret fort)
API_SECRET_TOKEN=<token_long_aleatoire>

# Bot Telegram
TELEGRAM_BOT_TOKEN=<token_botfather>
TELEGRAM_ALLOWED_CHAT_IDS=<ton_chat_id_numerique>

# OpenAI (optionnel — pour les photos IA)
OPENAI_API_KEY=<ta_cle_openai>

# Anthropic (pour le répondeur automatique)
ANTHROPIC_API_KEY=<ta_cle_anthropic>

# Chemins (laisser par défaut avec Docker)
DB_PATH=/data/hermes/hermes.db
SESSIONS_DIR=/data/hermes/sessions
MEDIA_DIR=/data/hermes/media
CHROMIUM_PATH=/usr/bin/chromium
```

---

## 4. Lancer les containers

```bash
docker compose up -d --build
```

Vérifier que tout tourne :

```bash
docker compose ps
docker compose logs -f backend     # logs backend
docker compose logs -f telegram    # logs bot Telegram
```

Santé du backend :

```bash
curl http://localhost:3001/health
# Réponse attendue : {"ok":true}
```

---

## 5. Configurer Nginx en reverse proxy (optionnel)

Pour exposer le dashboard sur un domaine :

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Créer la config Nginx
sudo tee /etc/nginx/sites-available/hermes << 'EOF'
server {
    listen 80;
    server_name TON_DOMAINE.fr;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/hermes /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS automatique
sudo certbot --nginx -d TON_DOMAINE.fr
```

---

## 6. Configurer les comptes LBC

Le bot Telegram affiche la liste des commandes. Utilise :

```
/ajouter_compte   — ajouter un compte Leboncoin
/status           — voir l'état des comptes
/stats            — statistiques du jour
```

Pour ajouter un compte manuellement via l'API :

```bash
curl -X POST http://localhost:3001/api/accounts \
  -H "Authorization: Bearer TON_API_SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"leboncoin","credentials_ref":"lbc_compte_a","active":true}'
```

---

## 7. Automatiser les mises à jour

```bash
# Script de mise à jour
cat > ~/update-hermes.sh << 'EOF'
#!/bin/bash
cd ~/hermes
git pull origin main
docker compose up -d --build --remove-orphans
docker image prune -f
echo "Hermès mis à jour — $(date)"
EOF
chmod +x ~/update-hermes.sh

# Cron hebdomadaire (lundi 3h du matin)
(crontab -l 2>/dev/null; echo "0 3 * * 1 ~/update-hermes.sh >> ~/hermes-update.log 2>&1") | crontab -
```

---

## 8. Sauvegardes automatiques

```bash
cat > ~/backup-hermes.sh << 'EOF'
#!/bin/bash
BACKUP_DIR=~/hermes-backups
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d-%H%M)
docker compose -f ~/hermes/docker-compose.yml exec -T backend \
  sqlite3 /data/hermes/hermes.db ".backup /tmp/backup-$DATE.db"
docker cp hermes-backend-1:/tmp/backup-$DATE.db "$BACKUP_DIR/"
find "$BACKUP_DIR" -name "*.db" -mtime +7 -delete
echo "Backup OK — $BACKUP_DIR/backup-$DATE.db"
EOF
chmod +x ~/backup-hermes.sh

# Backup quotidien à 2h
(crontab -l 2>/dev/null; echo "0 2 * * * ~/backup-hermes.sh >> ~/hermes-backup.log 2>&1") | crontab -
```

---

## Commandes utiles

```bash
# Voir les logs en direct
docker compose logs -f

# Redémarrer un service
docker compose restart backend

# Arrêter tout
docker compose down

# Voir l'espace utilisé
docker system df
du -sh ~/hermes/data/

# Accès shell dans le container
docker compose exec backend sh
```

---

## Architecture en production

```
VPS Ubuntu
├── Nginx (80/443) → reverse proxy
│   ├── :3000 → web dashboard
│   └── :3001 → API backend
├── Docker containers
│   ├── backend (SQLite + Playwright + jobs)
│   ├── web (Next.js dashboard)
│   └── telegram (bot Grammy)
└── Volume /data/hermes/
    ├── hermes.db (SQLite)
    ├── sessions/ (cookies LBC par compte)
    └── media/ (photos produits)
```
