#!/usr/bin/env bash
# Setup Hermès sur un VPS Ubuntu/Debian (une seule fois)
set -e

echo "[hermes] Installation des dépendances système..."
apt-get update -q
apt-get install -y --no-install-recommends \
  docker.io docker-compose-plugin \
  curl git sqlite3

echo "[hermes] Clone du repo..."
REPO_URL=${1:-"https://github.com/fansealteam-hue/hermes-dropshipping2"}
DEST="/opt/hermes"
git clone "$REPO_URL" "$DEST" 2>/dev/null || (cd "$DEST" && git pull)
cd "$DEST"

echo "[hermes] Configuration des secrets..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "IMPORTANT : éditez /opt/hermes/.env et renseignez :"
  echo "  TELEGRAM_BOT_TOKEN"
  echo "  TELEGRAM_ALLOWED_CHAT_IDS"
  echo "  API_SECRET_TOKEN"
  echo "  ANTHROPIC_API_KEY   (optionnel — pour le répondeur auto)"
  echo ""
  echo "Puis relancez : docker compose up -d"
  exit 0
fi

echo "[hermes] Build et démarrage des conteneurs..."
docker compose up -d --build

echo "[hermes] Vérification santé..."
sleep 10
curl -sf http://localhost:3001/health && echo " — backend OK" || echo " — backend KO (vérifiez les logs : docker compose logs backend)"

echo "[hermes] Déploiement terminé."
echo "  Backend  : http://localhost:3001"
echo "  Interface: http://localhost:3000"
echo "  Logs     : docker compose logs -f"
