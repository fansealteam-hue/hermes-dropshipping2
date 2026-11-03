# Hermès — Démarrage rapide (5 minutes)

## 1. Prérequis VPS

- Ubuntu 22.04 ou Debian 12
- Docker + Docker Compose installés
- Port 3001 (backend) et 3000 (web) disponibles en local

## 2. Cloner et configurer

```bash
git clone https://github.com/fansealteam-hue/hermes-dropshipping2 /opt/hermes
cd /opt/hermes
cp .env.example .env
```

Ouvrir `.env` et renseigner **obligatoirement** :

```bash
nano .env
```

| Variable | Où l'obtenir |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather sur Telegram → /newbot |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Envoyer un message au bot, puis `https://api.telegram.org/bot<TOKEN>/getUpdates` |
| `API_SECRET_TOKEN` | Générer : `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | console.anthropic.com (optionnel — répondeur auto) |

## 3. Lancer

```bash
docker compose up -d --build
```

Vérifier que tout tourne :

```bash
docker compose ps
curl http://localhost:3001/health
# → {"ok":true}
```

## 4. Ajouter un compte Leboncoin

```bash
sqlite3 /var/lib/docker/volumes/hermes_hermes_data/_data/hermes.db \
  "INSERT INTO seller_accounts (account_id, channel, label, active, credentials_ref, created_at)
   VALUES ('lbc_principal','leboncoin','Mon compte LBC',1,'mock_compte1',datetime('now'));"
```

> **Note** : `credentials_ref` commence par `mock_` pour les tests.  
> En production, remplacer par un identifiant vers ton gestionnaire de secrets.

## 5. Tester le bot Telegram

Envoyer au bot :
- `/start` → menu principal
- `/lien https://www.temu.com/...` → analyser un produit
- `/dashboard` → tableau de bord

## 6. Workflow complet

```
1. /lien <url temu>     → sélectionner variante + prix + compte LBC
2. Bot publie sur LBC   → notification quand c'est en ligne
3. Vente détectée       → alerte avec boutons COMMANDER / ANNULER
4. COMMANDER            → infos acheteur + lien fournisseur affichés
5. Acheter chez Temu    → /commande <id_vente> <ref_temu>
6. /suivi <id_vente> <transporteur> <numéro>
                        → transmis automatiquement à l'acheteur LBC
```

## 7. Logs en temps réel

```bash
docker compose logs -f backend    # API + jobs Leboncoin
docker compose logs -f telegram   # bot Telegram
```

## 8. Sauvegarde DB

```bash
# Sauvegarde manuelle
docker exec hermes-backend-1 sqlite3 /data/hermes/hermes.db \
  ".backup /data/hermes/backup-$(date +%Y%m%d-%H%M).db"

# Automatique toutes les nuits (cron)
echo "0 3 * * * docker exec hermes-backend-1 sqlite3 /data/hermes/hermes.db \
  '.backup /data/hermes/backup-\$(date +\%Y\%m\%d).db'" | crontab -
```
