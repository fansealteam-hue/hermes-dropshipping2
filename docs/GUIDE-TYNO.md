# Tyno Entreprise — le guide de A à Z

Tyno Entreprise, c'est ton outil de dropshipping **Temu → Leboncoin** : tu trouves un produit sur Temu, Tyno l'annonce sur Leboncoin, et quand il se vend, Tyno t'aide à le commander, à suivre le colis, à facturer et à tenir tes comptes.

Tout se pilote depuis **deux endroits** :

- **le site Tyno** (ton tableau de bord privé, protégé par mot de passe) ;
- **le bot Telegram** (tout au bouton, sur ton téléphone).

> ⚠️ **Règles de bon sens.** Tyno tourne sur ton serveur, avec tes propres comptes et tes réglages. Ce n'est pas l'automatisation qui pose problème, c'est l'abus : Leboncoin applique ses règles et peut suspendre un compte. Garde un rythme raisonnable (quelques annonces par jour et par compte), ne crée pas de comptes à la chaîne, et **le paiement sur Temu reste toujours validé par toi**.

---

## Sommaire

1. [Comment ça marche (vue d'ensemble)](#1-comment-ça-marche)
2. [Installer Tyno sur ton VPS](#2-installer-tyno-sur-ton-vps)
3. [Régler le fichier .env](#3-régler-le-fichier-env)
4. [Mettre le site en HTTPS avec ton nom de domaine](#4-mettre-le-site-en-https)
5. [Créer le bot Telegram](#5-créer-le-bot-telegram)
6. [Connecter tes comptes Leboncoin](#6-connecter-tes-comptes-leboncoin)
7. [Le site, page par page](#7-le-site-page-par-page)
8. [Le bot Telegram, bouton par bouton](#8-le-bot-telegram-bouton-par-bouton)
9. [La vie d'une vente, de A à Z](#9-la-vie-dune-vente-de-a-à-z)
10. [Ce qui se fait tout seul](#10-ce-qui-se-fait-tout-seul)
11. [Factures, URSSAF et rapports](#11-factures-urssaf-et-rapports)
12. [Sécurité](#12-sécurité)
13. [Mettre à jour Tyno](#13-mettre-à-jour-tyno)
14. [Dépannage](#14-dépannage)
15. [Pour aller plus loin (technique)](#15-pour-aller-plus-loin)

---

## 1. Comment ça marche

```
   Temu  ──(lien produit)──▶  Tyno  ──(annonce)──▶  Leboncoin
                               ▲                        │
                               │                     (vente)
          toi (site + Telegram) ◀── notification ───────┘
                │
                ├─ ✅ Disponible → 🛒 tu commandes sur Temu → ✅ J'ai commandé
                ├─ 📬 tu colles le numéro de suivi → envoyé à l'acheteur
                └─ 🧾 facture, compta, URSSAF, rapports : automatiques
```

Tyno, ce sont **3 programmes** qui tournent ensemble sur ton VPS (avec Docker) :

| Programme | Rôle | Adresse (sur le VPS) |
|---|---|---|
| **backend** | le cerveau : base de données, ventes, factures, automatisations, Leboncoin | `127.0.0.1:3001` |
| **web** | le site Tyno (tableau de bord privé) | `127.0.0.1:3000` |
| **telegram** | le bot Telegram | — |

---

## 2. Installer Tyno sur ton VPS

Il te faut un VPS **Ubuntu 22.04+ ou Debian 12** avec **Docker** et **Docker Compose**.

1. Connecte-toi à ton VPS :
   ```bash
   ssh root@ADRESSE_IP_DE_TON_VPS
   ```
2. Récupère le projet :
   ```bash
   git clone https://github.com/fansealteam-hue/hermes-dropshipping2 /opt/hermes
   cd /opt/hermes
   cp .env.example .env
   ```
3. Remplis le fichier `.env` (voir la [partie 3](#3-régler-le-fichier-env)) :
   ```bash
   nano .env
   ```
4. Lance tout :
   ```bash
   docker compose up -d --build
   ```
5. Vérifie :
   ```bash
   docker compose ps
   curl http://localhost:3001/health
   ```
   Tu dois voir les 3 services « running » et `{"ok":true}`.

> 💡 Le script `setup-vps.sh` fait les étapes 2 à 5 d'un coup sur un VPS neuf.

---

## 3. Régler le fichier .env

Le fichier `.env` contient tes réglages et tes secrets. **Il ne doit jamais être envoyé sur GitHub** (il est déjà ignoré).

### Obligatoire

| Variable | À mettre | Comment l'obtenir |
|---|---|---|
| `WEB_SECRET_TOKEN` | le **mot de passe du site** (12 caractères minimum) | invente-le, ou : `openssl rand -base64 18` |
| `API_SECRET_TOKEN` | un secret interne | `openssl rand -hex 32` |
| `TELEGRAM_BOT_TOKEN` | le token de ton bot | voir la [partie 5](#5-créer-le-bot-telegram) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | ton identifiant Telegram (chiffres) | voir la [partie 5](#5-créer-le-bot-telegram) |

### Recommandé

| Variable | À mettre | Effet |
|---|---|---|
| `SITE_URL` | l'adresse de ton site, ex. `https://tyno.mondomaine.fr` | boutons « 🌐 Site Tyno » dans Telegram |
| `MINI_APP_URL` | la même adresse **en HTTPS** | bouton « 📱 Ouvrir Tyno » (l'appli dans Telegram) |
| `TEMU_SHIPPING_FEE` | `2.99` | frais de port Temu comptés dans chaque bénéfice |
| `DAILY_LISTING_MAX` | `20` | nombre max d'annonces publiées par jour (reste raisonnable) |
| `PUBLISH_HOUR_START` / `END` | `8` / `18` | heures de publication automatique |

### Optionnel

| Variable | Effet |
|---|---|
| `ANTHROPIC_API_KEY` | réponses automatiques aux acheteurs rédigées par l'IA |
| `OPENAI_API_KEY` | amélioration des photos produits |
| `NEGO_ACCEPT_PCT`, `NEGO_COUNTER_PCT`, `NEGO_REFUSE_PCT` | règles de négociation automatique des offres |
| `REPRICE_DAYS_1`, `REPRICE_STEP_PCT`, `MAX_REPRICE_COUNT` | baisse automatique du prix des annonces qui ne se vendent pas |
| `AUTOMATION_TICK_MIN` | fréquence des automatisations (60 = toutes les heures) |
| `REPORT_PDF` | `0` = rapports en page web au lieu du PDF |

Après chaque changement du `.env` :
```bash
docker compose up -d
```

---

## 4. Mettre le site en HTTPS

Par sécurité, le site n'écoute que **sur le VPS lui-même** (`127.0.0.1:3000`). Pour l'ouvrir depuis ton téléphone ou ton ordinateur, le plus simple est **Caddy**, qui met le HTTPS tout seul.

1. Fais pointer ton nom de domaine (ex. `tyno.mondomaine.fr`) vers l'IP du VPS (enregistrement **A** chez ton registrar).
2. Installe Caddy :
   ```bash
   apt install -y caddy
   ```
3. Remplace le contenu de `/etc/caddy/Caddyfile` par :
   ```
   tyno.mondomaine.fr {
       reverse_proxy 127.0.0.1:3000
   }
   ```
4. Recharge Caddy :
   ```bash
   systemctl reload caddy
   ```
5. Dans `.env`, mets `SITE_URL=https://tyno.mondomaine.fr` et `MINI_APP_URL=https://tyno.mondomaine.fr`, puis `docker compose up -d`.

Ton site est maintenant sur `https://tyno.mondomaine.fr`, protégé par ton mot de passe (`WEB_SECRET_TOKEN`).

---

## 5. Créer le bot Telegram

1. Dans Telegram, ouvre **@BotFather** → `/newbot` → choisis un nom (ex. *Tyno*) → il te donne un **token** : mets-le dans `TELEGRAM_BOT_TOKEN`.
2. Envoie un message à ton nouveau bot (n'importe quoi).
3. Ouvre dans ton navigateur : `https://api.telegram.org/bot<TON_TOKEN>/getUpdates` et repère `"chat":{"id":123456789` → ce nombre va dans `TELEGRAM_ALLOWED_CHAT_IDS`.
4. Redémarre : `docker compose up -d`.
5. Dans Telegram, envoie `/start` à ton bot : les **boutons** apparaissent en bas.

> Le bot est **privé** : il ignore en silence toute personne qui n'est pas dans `TELEGRAM_ALLOWED_CHAT_IDS`.

---

## 6. Connecter tes comptes Leboncoin

Tyno publie sur Leboncoin avec **la session de ton compte** (comme si tu étais connecté). **Tu te connectes toi-même** : Tyno ne voit jamais ton mot de passe.

1. **Sur ton ordinateur** (il faut un écran), dans le dossier du projet :
   ```bash
   npm install
   npx playwright install chromium
   node apps/backend/scripts/lbc-session.js lbc_maison
   ```
   (`lbc_maison` = l'identifiant que tu choisis pour ce compte.)
2. Une fenêtre Leboncoin s'ouvre : **connecte-toi**, puis appuie sur Entrée dans le terminal. La session est enregistrée dans `sessions/lbc_maison.json`.
3. Envoie-la sur le VPS et range-la dans Tyno :
   ```bash
   scp sessions/lbc_maison.json root@ADRESSE_IP_DE_TON_VPS:/root/
   ```
   puis, sur le VPS, dans `/opt/hermes` :
   ```bash
   docker compose cp /root/lbc_maison.json backend:/data/hermes/sessions/lbc_maison.json
   ```
4. Déclare le compte dans Tyno (sur le VPS) :
   ```bash
   curl -X POST http://127.0.0.1:3001/admin/accounts -H "Content-Type: application/json" -H "Authorization: Bearer $(grep '^API_SECRET_TOKEN=' .env | cut -d= -f2 | cut -d' ' -f1)" -d '{"accountId":"lbc_maison","label":"Maison & Déco"}'
   ```
5. Sur le site, page **Comptes & trésorerie** : donne-lui sa **niche** (Maison, Bricolage, Tech…).

> 🔒 Le fichier de session donne accès à ton compte : garde-le pour toi, ne l'envoie à personne. Quand Leboncoin te redemande de te connecter, relance simplement l'étape 1.

---

## 7. Le site, page par page

Menu de gauche (sur téléphone : bouton **Plus** en bas). **Ctrl+K** = recherche rapide (vente, acheteur, page).

### Pilotage
- **🏠 Vue d'ensemble** — chiffre d'affaires, bénéfice, objectif du mois, heures où tes acheteurs achètent, ventes **par compte puis par niche** (CA, achats Temu, bénéfice net).
- **🏭 Tyno Warehouse** — ton **QG en 3D**, moitié bureaux, moitié emballage :
  - *bureaux* : Boss, Contrôle, Comptabilité, Trésorerie, URSSAF, Rapports, Achats Temu, Ventes, Service client, Annonces, Recherche niches, Facturation ;
  - *entrepôt* : Stock, Réception, Emballage, Étiquetage, tapis roulant, Quai d'expédition, Livrés ;
  - chaque équipe affiche ce qu'elle fait (calculé sur tes vraies ventes) : 🟠 en mission, 🟡 à valider par toi, 🟢 disponible ;
  - clic sur une étiquette = détail + bouton vers la bonne page ;
  - barre **« Écris au Boss »** : tape « commandes », « suivis », « factures », « rapport »… puis **✦ Mission** ;
  - glisser = tourner · molette ou − / + = zoom · ⌖ = recentrer ;
  - sous le QG : **défis du jour / de la semaine** et **tableau des objectifs** (un employé de plus à chaque palier de bénéfice : 100 €, 350 €, 500 €…).

### Opérations
- **🛒 Achats Temu** — les ventes à commander (infos acheteur à copier, bouton « Commander sur Temu », « Tout marquer commandé »), puis celles en attente du suivi.
- **🛍️ Ventes** — toutes les ventes, par compte puis par niche. Chaque vente suit **Payé → Commandé → Expédié → Reçu** et a les **mêmes boutons que Telegram** (voir [partie 9](#9-la-vie-dune-vente-de-a-à-z)). Une fiche **« Nouvelle vente »** apparaît en bas à droite quand une vente arrive.
- **💬 Messages** — tes conversations Leboncoin, réponses automatiques, modèles de messages modifiables.
- **📦 Produits** — ce qui se vend, ce qui bloque, performance par niche, calculateur de prix.
- **📢 Annonces** — annonces en ligne et programmées, publications des 7 derniers jours.

### Bureau
- **📒 Comptabilité** — CA, achats Temu, frais de port, autres dépenses, bénéfice net, évolution sur 12 mois, export CSV.
- **📊 Rapports** — ton rapport financier (semaine dernière, cette semaine, mois dernier, ce mois, trimestre) avec **Enregistrer en PDF**, **Fichier compta Excel** et **Envoyer sur Telegram**.
- **🧾 Facturation** — tes infos de facturation, factures et avoirs automatiques, **déclaration URSSAF**, et les **Automatisations** (tout ce qui se fait seul, avec un interrupteur pour chacune).
- **👥 Comptes & trésorerie** — chaque compte Leboncoin : son argent disponible, ce qui est en attente, ses retraits.

---

## 8. Le bot Telegram, bouton par bouton

Pas de commande à taper : **tout est au bouton**.

**Boutons fixes en bas :**

| Bouton | Ce qu'il fait |
|---|---|
| 📊 **Tableau de bord** | CA, achats, bénéfice net des 30 derniers jours, ce qui t'attend, 🔄 Actualiser, 📑 Rapport financier |
| 🛍️ **Ventes** | les ventes en cours avec leurs étapes |
| 🛒 **À commander** | les ventes à commander sur Temu : « 🛒 Temu » pour chacune, « ✅ commandé » qui se coche, « Tout est commandé » |
| 📬 **Ajouter un suivi** | tu choisis la commande, tu colles le numéro : le transporteur est reconnu et l'acheteur prévenu |
| 🔗 **Nouveau produit** | colle un lien Temu → photo du produit → variante → **3 prix proposés avec le bénéfice** (ou « ✏️ Autre prix ») → compte → publication maintenant / dans 1 h / ce soir / demain |
| 🌐 **Site Tyno** | raccourcis vers les pages du site |
| 📱 **Ouvrir Tyno** | l'appli Tyno dans Telegram (si `MINI_APP_URL` est en HTTPS) |

**Notifications automatiques :**
- 🔔 **Nouvelle vente** : une seule fiche avec la photo, le compte, le prix vendu, l'achat Temu, le bénéfice, le stock Temu et les boutons. La fiche **se met à jour** à chaque étape.
- ⏳ Rappel si un suivi manque depuis quelques jours.
- 🧾 Rappel de déclaration URSSAF.
- 📊 Rapport de la semaine (lundi) et 📑 du mois (le 1er, avec le fichier compta).

---

## 9. La vie d'une vente, de A à Z

1. **Un acheteur paie sur Leboncoin.** Tyno crée la vente, vérifie le stock et le prix sur Temu, et t'envoie la fiche (Telegram + site).
2. **Disponible ?**
   - Si tout est bon (en stock, rentable, prix stable), Tyno valide **tout seul** et passe directement à « Commander sur Temu ».
   - Sinon il te demande : **✅ Disponible** / **❌ Pas disponible** / **🔄 Revérifier**.
   - « Pas disponible » → confirmation → la vente est annulée et l'acheteur prévenu sur Leboncoin (un avoir est créé si besoin).
3. **Tu commandes sur Temu** avec le bouton 🛒 (nom et ville de l'acheteur affichés), puis **✅ J'ai commandé**.
4. **Le numéro de suivi arrive** : 📬 **Ajouter le suivi** → colle-le → transporteur reconnu (Colissimo, Mondial Relay, UPS, Chronopost…) → envoyé automatiquement à l'acheteur.
5. **Livré** : la vente passe en « Reçu », l'argent arrive sur le compte Leboncoin.
6. **Facture** créée automatiquement, et la vente compte dans la compta, l'URSSAF et les rapports.

---

## 10. Ce qui se fait tout seul

Réglable dans **Facturation → Automatisations** (un interrupteur par ligne) :

| Automatisation | Quand |
|---|---|
| Disponibilité validée toute seule (stock OK, rentable, prix pas monté de plus de 15 %) | à chaque vente |
| Annulation auto si rupture (**désactivée par défaut**) | à chaque vente |
| Factures et avoirs automatiques | à chaque vente / annulation |
| Messages à l'acheteur (expédition, annulation…) avec tes modèles | à chaque étape |
| Rappel « suivi manquant » sur Telegram | une fois par jour et par vente |
| Rappel de déclaration URSSAF | le 1er, le 15 et les 3 derniers jours |
| Rapport de la semaine (PDF) | chaque lundi |
| Rapport du mois (PDF) + fichier compta Excel | le 1er du mois |
| Fichier compta de la période | quand tu coches « Déclaré » |

**Ce qui reste toujours à toi :** payer sur Temu, et les retraits d'argent réels (Tyno les prépare, tu vérifies).

---

## 11. Factures, URSSAF et rapports

- **Factures** : numérotées `FA-2026-0001`, `FA-2026-0002`… ; avoirs `AV-…` en cas d'annulation. Remplis d'abord tes infos (nom, SIRET, adresse) dans **Facturation**.
- **URSSAF** : Tyno calcule le chiffre d'affaires à déclarer et les cotisations estimées, par mois ou par trimestre. Une fois déclaré sur autoentrepreneur.urssaf.fr, coche **« Déclaré »** : tu reçois le fichier compta de la période sur Telegram.
- **Rapports financiers** (PDF noir & orange) : CA, bénéfice net, ventes et marge **comparés à la période d'avant**, courbe jour par jour, où va l'argent, par compte, par niche, ce qui se vend / ce qui ne se vend pas, argent en attente, et **« Pour augmenter ton bénéfice »** (conseils calculés sur tes chiffres).
- **Fichier compta** (CSV) : s'ouvre directement dans Excel — récap, par compte, par niche et le détail de chaque vente (date, n° de facture, acheteur, prix, achat Temu, bénéfice).

> Les chiffres d'URSSAF sont des **estimations** : vérifie toujours avant de déclarer.

---

## 12. Sécurité

- Le site est **privé** : mot de passe (`WEB_SECRET_TOKEN`), session sécurisée, 8 essais max en 15 minutes, invisible pour Google. Sans mot de passe en production, le site reste **verrouillé**.
- Le site et le backend n'écoutent que **sur le VPS** : passe par Caddy (HTTPS) pour y accéder.
- Le bot Telegram ne répond **qu'à toi**.
- L'appli dans Telegram vérifie la signature Telegram et ton identifiant.
- Ne partage jamais : ton `.env`, tes fichiers de session Leboncoin, tes tokens.

---

## 13. Mettre à jour Tyno

Sur le VPS, dans le dossier du projet :
```bash
git pull origin main
```
```bash
docker compose up -d --build
```

Tes données (ventes, factures, sessions) sont gardées : elles sont dans le volume Docker `hermes_data`.

**Sauvegarde conseillée** (une fois par semaine) :
```bash
docker compose cp backend:/data/hermes/hermes.db ./sauvegarde-$(date +%F).db
```

---

## 14. Dépannage

| Problème | Solution |
|---|---|
| Le site demande un mot de passe que je n'ai pas | c'est `WEB_SECRET_TOKEN` dans `.env` |
| « Site verrouillé » | `WEB_SECRET_TOKEN` est vide : remplis-le puis `docker compose up -d` |
| Le bot ne répond pas | vérifie `TELEGRAM_BOT_TOKEN` et `TELEGRAM_ALLOWED_CHAT_IDS`, puis `docker compose logs telegram` |
| Pas de bouton « 🌐 Site Tyno » qui marche | remplis `SITE_URL` (pas `localhost`) |
| Pas de bouton « 📱 Ouvrir Tyno » | `MINI_APP_URL` doit être en **https://** |
| Les annonces ne partent pas | session Leboncoin expirée : relance la [partie 6](#6-connecter-tes-comptes-leboncoin) |
| Rapport reçu en page web au lieu du PDF | Chromium indisponible dans le conteneur ; le contenu est le même |
| Voir ce qui se passe | `docker compose logs -f` (ou `logs backend`, `logs web`, `logs telegram`) |
| Tout redémarrer | `docker compose restart` |

---

## 15. Pour aller plus loin

- **Code** : `apps/backend` (Express + SQLite, file de tâches, connecteurs Leboncoin Playwright), `apps/web` (site), `apps/telegram` (bot grammY).
- **Tests** : dans chaque dossier `apps/*`, `NODE_ENV=test npm test`.
- **Mode démo** du site : ajoute `?demo` à l'adresse (chiffres fictifs, rien n'est enregistré).
- Documentation technique historique : `docs/obsidian/` (architecture, contrats d'API, procédures VPS).
