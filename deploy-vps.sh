#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Hermès — Script de déploiement VPS (Ubuntu 22.04+)
# Usage : bash deploy-vps.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo "  🚀 Hermès — Déploiement VPS"
echo "  ─────────────────────────────"
echo ""

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  warn "Docker non trouvé — installation..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  ok "Docker installé"
else
  ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

if ! docker compose version &>/dev/null; then
  warn "Docker Compose plugin non trouvé — installation..."
  sudo apt-get install -y docker-compose-plugin
fi
ok "Docker Compose $(docker compose version --short)"

# ── 2. .env ──────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  warn "Fichier .env créé depuis .env.example"
  warn "→ Éditez .env avec vos tokens avant de continuer"
  warn "  nano .env"
  echo ""
  read -rp "Appuyez sur Entrée une fois .env configuré…"
fi

# Vérifier les variables obligatoires
check_var() {
  val=$(grep "^$1=" .env | cut -d'=' -f2-)
  if [ -z "$val" ] || [[ "$val" == *"changeme"* ]]; then
    err "Variable $1 non configurée dans .env"
  fi
}
check_var "API_SECRET_TOKEN"
check_var "TELEGRAM_BOT_TOKEN"
check_var "TELEGRAM_ALLOWED_CHAT_IDS"
ok "Variables .env OK"

# ── 3. Build & démarrage ─────────────────────────────────────────────────────
echo ""
echo "  📦 Build des images Docker (peut prendre 3–5 min)..."
docker compose build --parallel

echo "  🟢 Démarrage des services..."
docker compose up -d

# ── 4. Santé ─────────────────────────────────────────────────────────────────
echo "  ⏳ Attente que le backend soit prêt..."
MAX=30; i=0
until curl -sf http://localhost:3001/health > /dev/null 2>&1; do
  i=$((i+1))
  [ $i -ge $MAX ] && err "Backend non disponible après ${MAX}s"
  sleep 2
done
ok "Backend opérationnel (http://localhost:3001)"
ok "Dashboard (http://localhost:3000)"

# ── 5. Résumé ────────────────────────────────────────────────────────────────
echo ""
echo "  ─────────────────────────────────────────────"
echo "  ✅ Hermès déployé avec succès !"
echo ""
echo "  Services actifs :"
docker compose ps --format "table {{.Name}}\t{{.Status}}"
echo ""
echo "  Prochaines étapes :"
echo "  1. Configurer Nginx si domaine personnalisé"
echo "     → voir DEPLOIEMENT_VPS.md section 5"
echo "  2. Ajouter vos comptes LBC via Telegram"
echo "     → /ajouter_compte"
echo "  3. Activer les sauvegardes automatiques"
echo "     → voir DEPLOIEMENT_VPS.md section 8"
echo ""
echo "  Logs en direct : docker compose logs -f"
echo "  ─────────────────────────────────────────────"
