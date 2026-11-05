# Tyno Entreprise

**Ton dropshipping Temu → Leboncoin, de A à Z** : annonces, ventes, commandes Temu, suivi des colis, messages acheteurs, factures, URSSAF et rapports financiers — pilotés depuis un **site privé** et un **bot Telegram tout au bouton**.

📘 **Le guide complet : [docs/GUIDE-TYNO.md](docs/GUIDE-TYNO.md)**

## En bref

| | |
|---|---|
| 🏭 **Tyno Warehouse** | ton QG en 3D, moitié bureaux, moitié emballage, qui montre en direct ce que fait chaque équipe |
| 🛍️ **Ventes** | Payé → Commandé → Expédié → Reçu, avec les boutons ✅ Disponible / 🛒 Commander sur Temu / 📬 Suivi |
| 📲 **Telegram** | une fiche photo + boutons à chaque vente, nouveau produit en 5 boutons, rapports automatiques |
| 🧾 **Bureau** | factures et avoirs automatiques, déclaration URSSAF, compta, rapports PDF semaine et mois |
| 🔒 **Privé** | site protégé par mot de passe, bot qui ne répond qu'à toi |

## Démarrer

```bash
git clone https://github.com/fansealteam-hue/hermes-dropshipping2 /opt/hermes
cd /opt/hermes
cp .env.example .env      # puis remplis-le (voir le guide, partie 3)
docker compose up -d --build
```

## Mettre à jour

```bash
git pull origin main
docker compose up -d --build
```

## Structure

```
apps/backend    le cerveau : base de données, ventes, factures, automatisations, Leboncoin
apps/web        le site Tyno (tableau de bord privé + appli Telegram /tg)
apps/telegram   le bot Telegram
docs/           le guide (GUIDE-TYNO.md) et la doc technique
```

> Tyno tourne sur ton serveur, avec tes comptes. Garde un rythme raisonnable sur Leboncoin, et le paiement Temu reste toujours validé par toi.
