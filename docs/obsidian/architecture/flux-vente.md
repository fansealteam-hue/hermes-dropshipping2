# Cycle de vie d'une vente

## États `sales.status`

```
confirmed → order_placed → shipped → (closed)
     ↓
  cancelled
```

## Transitions

| De | Vers | Déclencheur | Endpoint |
|----|------|-------------|----------|
| confirmed | order_placed | Opérateur confirme commande Temu | `POST /sales/:id/confirm-order` |
| confirmed | cancelled | Opérateur annule | `POST /sales/:id/cancel` |
| order_placed | shipped | Tracking ajouté + livraison confirmée | `PATCH /sales/:id/tracking` + worker |
| — | cancelled | Annulation depuis LBC | `POST /sales/:id/cancel` |

## Flux Telegram bot

```
Alert vente → bot envoie message avec boutons
  ├─ [Commander] → état awaiting_order_details → saisir ref + prix → order_placed
  ├─ [Annuler] → prompt confirmation → cancel_confirm:id → cancelled
  └─ [Suivi] → état awaiting_tracking_number → saisir numéro → tracking enregistré
```

## Flux annonce

```
draft → (worker publish_listing) → active
  └─ si échec max_attempts → failed
```

## Idempotence

- Ventes : `external_event_id UNIQUE` — doublon retourne `{ duplicate: true }`
- Callbacks bot : table `callback_log` — `{ alreadyDone: true }`
- Jobs : `idempotency_key UNIQUE` — pas de double enfilage

## Sécurité données

- `delivery_address` jamais stockée (ville uniquement dans `delivery_city`)
- `buyer_name` stocké pour opérationnel, pas dans `sale_history`
- Tokens/secrets : `.env` uniquement, jamais dans les fichiers commités
