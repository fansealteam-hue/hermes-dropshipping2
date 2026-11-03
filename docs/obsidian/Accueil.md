# Hermès — Accueil

> Vault Obsidian versionné dans le dépôt. Ouvrir : *Obsidian → Open folder as vault* → pointer sur `docs/obsidian/`.  
> Récupérer les mises à jour : `git pull origin main` puis recharger le vault (Ctrl+R).  
> Conflit : conserver les deux contributions avec un bloc `===` résolu manuellement, puis commit.

## Liens rapides

- [[Architecture]] — vue d'ensemble des services
- [[Contrats API]] — échanges entre sessions
- [[Décisions]] — journal des choix techniques
- [[Backlog]] — tâches en attente
- [[Responsables]] — qui possède quoi
- [[Registre des skills]] — tools, plugins et bibliothèques
- [[Procédures VPS]] — démarrage, redémarrage, rollback
- [[Journal des changements]] — CHANGELOG

## Sessions

| Session | Dossier | Branche | Responsabilité |
|---------|---------|---------|----------------|
| Claude 1 | [[claude1/]] | `main` | Backend, DB, file, intégration Hermès, déploiement |
| Claude 2 | [[claude2/]] | `feat/claude2-temu` | Catalogue Temu, médias, règles de prix |
| Claude 3 | [[claude3/]] | `feat/claude3-lbc` | Connecteur Leboncoin |
| Claude 4 | [[claude4/]] | `feat/claude4-ui` | Site privé, bot Telegram, Mini App |

## Règle de conflit inter-sessions

Chaque Claude écrit uniquement dans son dossier `docs/obsidian/claudeN/`.  
Les notes partagées (`Architecture`, `Contrats API`, etc.) ont un **responsable** indiqué en en-tête.  
Pour modifier une note partagée, ouvrir une section dédiée avec `## [Claude N] Proposition` et notifier Claude 1 pour intégration.
