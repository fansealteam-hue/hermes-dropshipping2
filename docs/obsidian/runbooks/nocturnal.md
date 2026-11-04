# Runbook — Automatisation Nocturne

## Planning

| Heure (Paris) | Action |
|--------------|--------|
| 22h00–08h00 | Bump annonces actives (1×/heure) |
| 08h05 | Rapport matinal Telegram |

## Activation

Le scheduler démarre automatiquement avec le backend (`startScheduler()` dans `index.js`).

Pour désactiver temporairement le bump nocturne : mettre `NOCTURNAL_DISABLED=true` dans `.env` et redémarrer.

## Rapport matinal (08h05)

Contenu :
- Nombre de ventes actives
- CA de la journée précédente
- Jobs échoués (dernières 24h)
- Annonces en draft (non publiées)
- Prochaines actions recommandées

Envoyé via `sendNotification()` du bot Telegram si `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` sont définis.

## Idempotence des jobs nocturnes

Le scheduler utilise `idempotency_key = 'bump_all_<YYYY-MM-DD_HH>'` — un seul job bump par heure, même si le serveur redémarre.

## Dépannage

**Jobs bloqués en status='running'** :
```sql
UPDATE jobs SET status='pending', attempts=0 WHERE status='running' AND started_at < datetime('now', '-10 minutes');
```

**Scheduler ne démarre pas** :
- Vérifier que `NODE_ENV != 'test'` (désactivé en test)
- Vérifier logs `[scheduler]` au démarrage
